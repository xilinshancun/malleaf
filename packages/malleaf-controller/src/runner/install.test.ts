import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createRuntimeFixture, removeFixture } from "../test-fixtures/runtime.js";
import { exists } from "../storage.js";
import { initializeRuntime } from "./initialize.js";
import { installStableRunner } from "./install.js";
import { acquireControlLease } from "./lease.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeFixture(root);
});

async function fixture() {
  const f = await createRuntimeFixture();
  roots.push(f.root);
  const pair = await f.pair("first", "// stable runner fixture\n");
  const initialized = await initializeRuntime({ home: f.home, initialPair: pair });
  return {
    ...f,
    initial: pair,
    initialized,
    entry: path.join(f.home, "runner/stable/runner.cjs"),
    sidecar: path.join(f.home, "runner/stable/runner.json"),
  };
}

test("install is create-once, repairs a missing sidecar, and never changes runtime selection", async () => {
  const f = await fixture();
  const before = await readFile(f.filename, "utf8");
  expect((await installStableRunner(f)).status).toBe("installed");
  expect(await readFile(f.entry, "utf8")).toBe("// stable runner fixture\n");
  expect((await installStableRunner(f)).status).toBe("already_installed");
  await rm(f.sidecar);
  expect((await installStableRunner(f)).status).toBe("repaired");
  expect(await readFile(f.filename, "utf8")).toBe(before);
  expect(await exists(path.join(f.home, "runner/instances.json"))).toBe(false);
  expect(await exists(path.join(f.home, "runner/switch.json"))).toBe(false);
});

test("different installed bytes and damaged metadata are retained for explicit repair", async () => {
  const f = await fixture();
  await installStableRunner(f);
  await writeFile(f.sidecar, "{broken");
  await expect(installStableRunner(f)).rejects.toMatchObject({ code: "invalid_state" });
  expect(await readFile(f.sidecar, "utf8")).toBe("{broken");
  await chmod(f.entry, 0o600);
  await writeFile(f.entry, "different bytes");
  await expect(installStableRunner(f)).rejects.toMatchObject({ code: "state_conflict" });
  expect(await readFile(f.entry, "utf8")).toBe("different bytes");
});

test("installation uses the persisted lease and refuses a live controller", async () => {
  const f = await fixture();
  const owner = await acquireControlLease({
    home: f.home,
    port: f.initialized.controlPort,
    buildId: f.initial.buildId,
    role: "controller",
  });
  try {
    await expect(installStableRunner(f)).rejects.toMatchObject({ code: "lease_held" });
    expect(await exists(f.entry)).toBe(false);
  } finally {
    await owner.release({ seal: async () => {} });
  }
});

test("an unselected source and a future writer requirement cannot install", async () => {
  const f = await fixture();
  const other = await f.pair("other", "// other runner\n");
  await expect(
    installStableRunner({ home: f.home, sourceBuildId: other.buildId }),
  ).rejects.toMatchObject({ code: "state_conflict" });
  const filename = path.join(f.home, "runner/runner.json");
  const config = JSON.parse(await readFile(filename, "utf8"));
  await writeFile(filename, JSON.stringify({ ...config, schemaVersion: 2, minWriterVersion: 2 }));
  await expect(installStableRunner(f)).rejects.toMatchObject({ code: "unsupported_schema" });
  expect(await exists(f.entry)).toBe(false);
});

test("metadata without an installed entry is not silently repaired", async () => {
  const f = await fixture();
  await installStableRunner(f);
  await rm(f.entry);
  await expect(installStableRunner(f)).rejects.toMatchObject({ code: "invalid_state" });
  expect(await exists(f.entry)).toBe(false);
});

test("installation never completes an unfinished initialization", async () => {
  const f = await fixture();
  await rm(f.filename);
  await expect(installStableRunner(f)).rejects.toMatchObject({ code: "invalid_state" });
  expect(await exists(f.entry)).toBe(false);
  expect(await exists(f.filename)).toBe(false);
});
