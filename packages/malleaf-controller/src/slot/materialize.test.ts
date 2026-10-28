import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { materializeSlot, verifySlot } from "./materialize.js";

const roots: string[] = [];

async function makeWritable(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await makeWritable(filename);
    if (entry.isFile()) await chmod(filename, 0o600);
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "malleaf-slot-"));
  roots.push(root);
  const sourceRoot = path.join(root, "source");
  const versionsRoot = path.join(root, "versions");
  await mkdir(path.join(sourceRoot, "packages/server/dist"), { recursive: true });
  await writeFile(
    path.join(sourceRoot, "packages/server/dist/main.js"),
    "process.stdout.write('b0');\n",
  );
  return {
    sourceRoot,
    versionsRoot,
    paths: ["packages/server/dist/main.js"],
    entries: { supervisor: "packages/server/dist/main.js" },
    provenance: {
      product: "0.1.0",
      display: "0.1.0.alice-1",
      sourceCommit: "a".repeat(40),
      upstream: "b".repeat(40),
      builder: "development",
      createdAt: "2026-10-28T00:00:00.000Z",
    },
  };
}

test("a slot survives removal of its source and detects changed executable bytes", async () => {
  const options = await fixture();
  const slot = await materializeSlot(options);
  await rm(options.sourceRoot, { recursive: true });
  expect(
    (
      await verifySlot({
        directory: slot.directory,
        expectedBuildId: slot.manifest.buildId,
        mode: "full",
      })
    ).buildId,
  ).toBe(slot.manifest.buildId);
  const entry = path.join(slot.directory, options.entries.supervisor);
  expect(await readFile(entry, "utf8")).toContain("b0");
  await chmod(entry, 0o644);
  await writeFile(entry, "process.stdout.write('wrong');\n");
  await expect(
    verifySlot({
      directory: slot.directory,
      expectedBuildId: slot.manifest.buildId,
      mode: "entries",
    }),
  ).rejects.toMatchObject({
    code: "artifact_changed",
  });
});

test("missing entries and paths outside the source never publish a slot", async () => {
  const options = await fixture();
  await expect(materializeSlot({ ...options, paths: ["../secret"] })).rejects.toMatchObject({
    code: "unsafe_path",
  });
  await expect(
    materializeSlot({ ...options, entries: { supervisor: "missing.js" } }),
  ).rejects.toThrow();
  expect(await readdir(options.versionsRoot)).toEqual([]);
});

test.each([".git/index", ".GIT/index"])(
  "runtime artifacts cannot bundle %s metadata discovered by tracing",
  async (metadataPath) => {
    const options = await fixture();
    await mkdir(path.join(options.sourceRoot, path.dirname(metadataPath)));
    await writeFile(path.join(options.sourceRoot, metadataPath), "private repository metadata");
    await expect(
      materializeSlot({ ...options, paths: [...options.paths, metadataPath] }),
    ).rejects.toMatchObject({ code: "unsafe_path" });
    expect(await readdir(options.versionsRoot)).toEqual([]);
  },
);

test("workspace links resolve only within the copied slot", async () => {
  const options = await fixture();
  await mkdir(path.join(options.sourceRoot, "node_modules/@getpaseo"), { recursive: true });
  await symlink(
    "../../packages/server",
    path.join(options.sourceRoot, "node_modules/@getpaseo/server"),
    "junction",
  );
  const slot = await materializeSlot({
    ...options,
    paths: [...options.paths, "node_modules/@getpaseo/server"],
  });
  await rm(options.sourceRoot, { recursive: true });
  expect(
    await readFile(path.join(slot.directory, "node_modules/@getpaseo/server/dist/main.js"), "utf8"),
  ).toContain("b0");
  await verifySlot({
    directory: slot.directory,
    expectedBuildId: slot.manifest.buildId,
    mode: "full",
  });
});

test("escaping source symlinks are refused without copying their targets", async () => {
  const options = await fixture();
  const outside = path.join(options.sourceRoot, "../outside");
  await writeFile(outside, "private");
  await symlink(outside, path.join(options.sourceRoot, "escape"));
  await expect(
    materializeSlot({ ...options, paths: [...options.paths, "escape"] }),
  ).rejects.toMatchObject({ code: "unsafe_path" });
  expect(await readdir(options.versionsRoot)).toEqual([]);
});

test("changed bytes get a new identity and unchanged bytes reuse verified artifacts", async () => {
  const options = await fixture();
  const first = await materializeSlot(options);
  const repeated = await materializeSlot(options);
  expect(repeated.manifest.buildId).toBe(first.manifest.buildId);
  await writeFile(path.join(options.sourceRoot, options.entries.supervisor), "changed");
  const second = await materializeSlot(options);
  expect(second.manifest.buildId).not.toBe(first.manifest.buildId);
});

test("entry mapping and provenance are part of the selected build identity", async () => {
  const options = await fixture();
  await writeFile(path.join(options.sourceRoot, "other.js"), "different entry");
  options.paths.push("other.js");
  const slot = await materializeSlot(options);
  const next = await materializeSlot({
    ...options,
    provenance: { ...options.provenance, display: "0.1.0.alice-2" },
  });
  expect(next.manifest.buildId).not.toBe(slot.manifest.buildId);
  const manifestFile = path.join(slot.directory, "malleaf.json");
  await chmod(manifestFile, 0o600);
  await writeFile(
    manifestFile,
    JSON.stringify({ ...slot.manifest, entries: { supervisor: "other.js" } }),
  );
  await expect(
    verifySlot({ directory: slot.directory, expectedBuildId: slot.manifest.buildId, mode: "full" }),
  ).rejects.toMatchObject({ code: "artifact_changed" });
});

test("a valid artifact stored under the wrong build directory is rejected", async () => {
  const options = await fixture();
  const slot = await materializeSlot(options);
  const renamed = path.join(options.versionsRoot, "f".repeat(64));
  await chmod(slot.directory, 0o755);
  await rename(slot.directory, renamed);
  await expect(
    verifySlot({ directory: renamed, expectedBuildId: slot.manifest.buildId, mode: "entries" }),
  ).rejects.toMatchObject({ code: "artifact_changed" });
});

test("materialization refuses a protected Paseo location before creating files", async () => {
  const options = await fixture();
  const installedPaseo = path.join(path.dirname(options.sourceRoot), "installed-paseo");
  await expect(
    materializeSlot({
      ...options,
      versionsRoot: path.join(installedPaseo, "versions"),
      protectedPaths: [installedPaseo],
    }),
  ).rejects.toThrow("cannot use the installed Paseo home");
  await expect(readdir(installedPaseo)).rejects.toMatchObject({ code: "ENOENT" });
});
