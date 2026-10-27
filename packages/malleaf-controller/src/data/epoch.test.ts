import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { executeEpochCopy, planEpochCopy } from "./epoch.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "malleaf-epoch-"));
  roots.push(root);
  const sourceHome = path.join(root, "old");
  await mkdir(sourceHome);
  await writeFile(path.join(sourceHome, "server-id"), "same-server");
  await writeFile(path.join(sourceHome, "daemon-keypair.json"), '{"private":"preserve"}');
  return {
    sourceHome,
    dataRoot: path.join(root, "data"),
    dataId: "trial-1",
    buildId: "a".repeat(64),
    shared: {
      plugins: path.join(root, "plugins"),
      worktrees: path.join(root, "worktrees"),
      models: path.join(root, "models/local-speech"),
    },
    policy: { schemaVersion: 1 as const, entries: {} },
  };
}

test("copies unknown durable state and identities, removes runtime files, leaves the original unchanged", async () => {
  const options = await fixture();
  await mkdir(path.join(options.sourceHome, "custom-feature"));
  await writeFile(path.join(options.sourceHome, "custom-feature/data.json"), '{"new":42}');
  await writeFile(path.join(options.sourceHome, "local-credential"), "do-not-copy");
  await mkdir(path.join(options.sourceHome, "runtime"));
  await writeFile(path.join(options.sourceHome, "runtime/process.json"), '{"pid":123}');
  const plan = await planEpochCopy(options);
  expect(plan.blockers).toEqual([]);
  const epoch = await executeEpochCopy(plan);
  expect(await readFile(path.join(epoch.directory, "custom-feature/data.json"), "utf8")).toBe(
    '{"new":42}',
  );
  expect(await readFile(path.join(epoch.directory, "server-id"), "utf8")).toBe("same-server");
  expect(await readFile(path.join(epoch.directory, "daemon-keypair.json"), "utf8")).toBe(
    '{"private":"preserve"}',
  );
  expect(await readdir(epoch.directory)).not.toContain("local-credential");
  expect(await readdir(epoch.directory)).not.toContain("runtime");
  expect(await readFile(path.join(options.sourceHome, "local-credential"), "utf8")).toBe(
    "do-not-copy",
  );
  expect(await readdir(options.dataRoot)).toEqual(["trial-1"]);
});

test("reports active state, external links, and unrelocated shared data before writing", async () => {
  const options = await fixture();
  await writeFile(path.join(options.sourceHome, "paseo.pid"), '{"pid":123}');
  await mkdir(path.join(options.sourceHome, "worktrees"));
  await symlink(options.dataRoot, path.join(options.sourceHome, "unknown-link"), "dir");
  const plan = await planEpochCopy(options);
  expect(plan.blockers.map((item) => item.code)).toEqual(
    expect.arrayContaining(["source_locked", "shared_dir_in_home", "external_symlink"]),
  );
  await expect(executeEpochCopy(plan)).rejects.toMatchObject({ code: "epoch_blocked" });
  await expect(readdir(options.dataRoot)).rejects.toMatchObject({ code: "ENOENT" });
});

test("rebases internal links and managed plugin config through the new alias", async () => {
  const options = await fixture();
  await mkdir(path.join(options.shared.plugins, "example/version"), { recursive: true });
  await writeFile(
    path.join(options.shared.plugins, "sources.json"),
    JSON.stringify({ example: { kind: "npm" } }),
  );
  await symlink(options.shared.plugins, path.join(options.sourceHome, "plugins"), "junction");
  await symlink(
    path.join(options.sourceHome, "server-id"),
    path.join(options.sourceHome, "identity-link"),
  );
  const original = JSON.stringify({
    customSetting: { preserved: true },
    plugins: { example: { path: path.join(options.sourceHome, "plugins/example/version") } },
  });
  await writeFile(path.join(options.sourceHome, "config.json"), original);
  const epoch = await executeEpochCopy(await planEpochCopy(options));
  const config = JSON.parse(await readFile(path.join(epoch.directory, "config.json"), "utf8"));
  expect(config.customSetting).toEqual({ preserved: true });
  expect(config.plugins.example.path).toBe(path.join(epoch.directory, "plugins/example/version"));
  const canonicalRoot = await realpath(path.dirname(options.sourceHome));
  expect(config.worktrees.root).toBe(path.join(canonicalRoot, "worktrees"));
  expect(config.providers.local.modelsDir).toBe(path.join(canonicalRoot, "models/local-speech"));
  await rm(path.join(options.sourceHome, "server-id"));
  expect(await readFile(path.join(epoch.directory, "identity-link"), "utf8")).toBe("same-server");
  expect(await readFile(path.join(options.sourceHome, "config.json"), "utf8")).toBe(original);
});

test("a changed source invalidates a previously prepared copy plan", async () => {
  const options = await fixture();
  const plan = await planEpochCopy(options);
  await writeFile(path.join(options.sourceHome, "server-id"), "different");
  await expect(executeEpochCopy(plan)).rejects.toMatchObject({ code: "state_conflict" });
  await expect(readdir(options.dataRoot)).rejects.toMatchObject({ code: "ENOENT" });
});

test("large unknown data needs a decision but explicitly copied data is allowed", async () => {
  const options = await fixture();
  const blocked = await planEpochCopy({ ...options, maxUnknownBytes: 1 });
  expect(blocked.blockers.some((item) => item.code === "size_over_threshold")).toBe(true);
  const accepted = await planEpochCopy({
    ...options,
    maxUnknownBytes: 1,
    policy: {
      schemaVersion: 1,
      entries: { "server-id": { kind: "copied" }, "daemon-keypair.json": { kind: "copied" } },
    },
  });
  expect(accepted.blockers).toEqual([]);
});

test("unknown configuration and schedule paths cannot write through the previous epoch", async () => {
  const options = await fixture();
  await mkdir(path.join(options.sourceHome, "schedules"));
  await writeFile(
    path.join(options.sourceHome, "schedules/custom.json"),
    JSON.stringify({ customOutput: path.join(options.sourceHome, "new-format/data.db") }),
  );
  await writeFile(
    path.join(options.sourceHome, "config.json"),
    JSON.stringify({ customModule: { destination: path.join(options.sourceHome, "custom") } }),
  );
  const plan = await planEpochCopy(options);
  expect(
    plan.blockers
      .filter((entry) => entry.code === "source_path_in_json")
      .map((entry) => entry.path),
  ).toEqual(["schedules/custom.json", "config.json"]);
  await expect(executeEpochCopy(plan)).rejects.toMatchObject({ code: "epoch_blocked" });
});

test("protected installed state cannot be declared as a shared resource", async () => {
  const options = await fixture();
  const installedPaseo = path.join(path.dirname(options.sourceHome), "installed-paseo");
  await expect(
    planEpochCopy({
      ...options,
      protectedPaths: [installedPaseo],
      policy: {
        schemaVersion: 1,
        entries: { custom: { kind: "shared", target: path.join(installedPaseo, "projects") } },
      },
    }),
  ).rejects.toThrow("cannot use the installed Paseo home");
  await expect(readdir(installedPaseo)).rejects.toMatchObject({ code: "ENOENT" });
});

test("an existing epoch can be copied into a sibling epoch", async () => {
  const options = await fixture();
  await mkdir(options.dataRoot);
  const oldEpoch = path.join(options.dataRoot, "old-epoch");
  await rename(options.sourceHome, oldEpoch);
  const copied = await executeEpochCopy(await planEpochCopy({ ...options, sourceHome: oldEpoch }));
  expect(await readFile(path.join(copied.directory, "server-id"), "utf8")).toBe("same-server");
});

test("excludes date-prefixed daemon rotations without dropping similarly named user files", async () => {
  const options = await fixture();
  const runtimeLogs = ["daemon.log", "daemon.log.txt", "20261028-0554-01-daemon.log"];
  const durable = ["20261028-custom-daemon.log", "my-daemon.log", "20261028-0554-01-notes.log"];
  for (const name of [...runtimeLogs, ...durable])
    await writeFile(path.join(options.sourceHome, name), name);
  const epoch = await executeEpochCopy(await planEpochCopy(options));
  const names = await readdir(epoch.directory);
  for (const name of runtimeLogs) expect(names).not.toContain(name);
  for (const name of durable) expect(names).toContain(name);
  for (const name of runtimeLogs)
    expect(await readFile(path.join(options.sourceHome, name), "utf8")).toBe(name);
});
