import { readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createRuntimeFixture, removeFixture } from "../test-fixtures/runtime.js";
import { initializeRuntime } from "./initialize.js";
import { acquireControlLease } from "./lease.js";
import { exists } from "../storage.js";
import { openPointerStore } from "./pointer.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeFixture(root);
});

test("missing inputs and incomplete pairs cannot publish runner configuration", async () => {
  const options = await fixture();
  await expect(initializeRuntime({ home: options.home })).rejects.toMatchObject({
    code: "state_conflict",
  });
  const first = await options.pair("first");
  await rm(path.join(options.home, "data/first/epoch.json"));
  await expect(initializeRuntime({ home: options.home, initialPair: first })).rejects.toThrow();
  expect(await exists(path.join(options.home, "runner/runner.json"))).toBe(false);
  expect(await exists(options.filename)).toBe(false);
});

test("malformed or orphaned state is retained for diagnosis instead of being reinitialized", async () => {
  const options = await fixture();
  const first = await options.pair("first");
  await initializeRuntime({ home: options.home, initialPair: first });
  const configFile = path.join(options.home, "runner/runner.json");
  const config = await readFile(configFile, "utf8");
  const pointer = await readFile(options.filename, "utf8");
  await writeFile(configFile, "{broken");
  await expect(initializeRuntime({ home: options.home, initialPair: first })).rejects.toMatchObject(
    { code: "invalid_state" },
  );
  expect(await readFile(configFile, "utf8")).toBe("{broken");
  await rm(configFile);
  await expect(initializeRuntime({ home: options.home, initialPair: first })).rejects.toMatchObject(
    { code: "state_conflict" },
  );
  expect(await readFile(options.filename, "utf8")).toBe(pointer);
  await writeFile(configFile, config);
  await writeFile(options.filename, "{broken");
  await expect(initializeRuntime({ home: options.home, initialPair: first })).rejects.toMatchObject(
    { code: "invalid_state" },
  );
  expect(await readFile(options.filename, "utf8")).toBe("{broken");
});

test("resuming never reassigns an occupied configured port", async () => {
  const options = await fixture();
  const first = await options.pair("first");
  const initial = await initializeRuntime({ home: options.home, initialPair: first });
  await rm(options.filename);
  const configFile = path.join(options.home, "runner/runner.json");
  const before = await readFile(configFile, "utf8");
  const owner = await acquireControlLease({
    home: options.home,
    port: initial.controlPort,
    buildId: first.buildId,
    role: "controller",
  });
  try {
    await expect(initializeRuntime({ home: options.home })).rejects.toMatchObject({
      code: "lease_held",
    });
    expect(await readFile(configFile, "utf8")).toBe(before);
    expect(await exists(options.filename)).toBe(false);
  } finally {
    await owner.release({ seal: async () => {} });
  }
  expect(await initializeRuntime({ home: options.home })).toMatchObject({
    status: "resumed",
    pair: first,
  });
});

test("two processes elect one initial pair and retain both complete epochs", async () => {
  const options = await fixture();
  const first = await options.pair("first");
  const second = await options.pair("second");
  const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const entry = new URL("./initialize.ts", import.meta.url).href;
  const script = `
    const { initializeRuntime } = await import(process.argv[1]);
    try {
      const result = await initializeRuntime({ home: process.argv[2], initialPair: JSON.parse(process.argv[3]) });
      console.log(JSON.stringify(result));
    } catch (error) {
      if (!['state_conflict', 'lease_held'].includes(error.code)) throw error;
      console.log(JSON.stringify({status: 'conflict'}));
    }
  `;
  const outputs = await Promise.all(
    [first, second].map((pair) =>
      promisify(execFile)(
        process.execPath,
        [
          "--conditions=source",
          "--import",
          loader,
          "--input-type=module",
          "-e",
          script,
          entry,
          options.home,
          JSON.stringify(pair),
        ],
        {
          timeout: 10000,
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                ([key]) => !key.startsWith("PASEO_") && !key.startsWith("MALLEAF_"),
              ),
            ),
            HOME: options.root,
            USERPROFILE: options.root,
          },
        },
      ),
    ),
  );
  const results = outputs.map((output) => JSON.parse(output.stdout));
  expect(results.filter((result) => result.status === "initialized")).toHaveLength(1);
  for (const result of results)
    expect(["initialized", "already_initialized", "conflict"]).toContain(result.status);
  const config = JSON.parse(await readFile(path.join(options.home, "runner/runner.json"), "utf8"));
  const pointer = JSON.parse(await readFile(options.filename, "utf8"));
  expect(pointer.current).toEqual(config.initialPair);
  expect([first, second]).toContainEqual(pointer.current);
  expect(await exists(path.join(options.home, "data/first/epoch.json"))).toBe(true);
  expect(await exists(path.join(options.home, "data/second/epoch.json"))).toBe(true);
  for (const output of outputs) expect(output.stderr).toBe("");
});

test("another home occupying the configured port is identified as a collision", async () => {
  const options = await fixture();
  const other = await fixture();
  const first = await options.pair("first");
  const initial = await initializeRuntime({ home: options.home, initialPair: first });
  await rm(options.filename);
  const owner = await acquireControlLease({
    home: other.home,
    port: initial.controlPort,
    buildId: first.buildId,
    role: "controller",
  });
  try {
    await expect(initializeRuntime({ home: options.home })).rejects.toMatchObject({
      code: "port_occupied",
      message: expect.stringContaining("another Malleaf home"),
    });
    expect(await exists(options.filename)).toBe(false);
  } finally {
    await owner.release({ seal: async () => {} });
  }
});

test("already initialized inspection does not require a damaged trial to be bootable", async () => {
  const options = await fixture();
  const first = await options.pair("first");
  const next = await options.pair("next");
  const initial = await initializeRuntime({ home: options.home, initialPair: first });
  const owner = await acquireControlLease({
    home: options.home,
    port: initial.controlPort,
    buildId: first.buildId,
    role: "controller",
  });
  const store = await openPointerStore({
    home: options.home,
    writerToken: owner.token,
    assertOwned: owner.assertOwned,
  });
  try {
    await store.beginTrial({ pair: next, switchId: "trial", candidateToken: "candidate" });
    await rm(path.join(options.home, "data/next/epoch.json"));
    expect(await initializeRuntime({ home: options.home })).toMatchObject({
      status: "already_initialized",
      pair: first,
    });
    await store.revert({ switchId: "trial", candidateToken: "candidate" });
  } finally {
    await owner.release({ seal: () => store.seal() });
  }
});
async function fixture() {
  const runtime = await createRuntimeFixture();
  roots.push(runtime.root);
  return runtime;
}

test("initialization resumes the originally recorded pair after partial publication", async () => {
  const options = await fixture();
  const first = await options.pair("first");
  const next = await options.pair("next");
  const initial = await initializeRuntime({ home: options.home, initialPair: first });
  expect(initial).toMatchObject({ status: "initialized", pair: first });
  const configFile = path.join(options.home, "runner/runner.json");
  const config = await readFile(configFile, "utf8");
  await rm(options.filename);
  expect(await initializeRuntime({ home: options.home, initialPair: next })).toEqual({
    status: "resumed",
    controlPort: initial.controlPort,
    pair: first,
  });
  expect(await readFile(configFile, "utf8")).toBe(config);
  const pointer = await readFile(options.filename, "utf8");
  expect(await initializeRuntime({ home: options.home, initialPair: next })).toEqual({
    status: "already_initialized",
    controlPort: initial.controlPort,
    pair: first,
  });
  expect(await readFile(options.filename, "utf8")).toBe(pointer);
});
