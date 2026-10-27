import { readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createRuntimeFixture, removeFixture } from "../test-fixtures/runtime.js";
import { executeEpochCopy, planEpochCopy } from "../data/epoch.js";
import { openPointerStore } from "./pointer.js";
import { StorageError, writeJsonAtomic } from "../storage.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeFixture(root);
});
async function fixture() {
  const runtime = await createRuntimeFixture();
  roots.push(runtime.root);
  return runtime;
}

test("trial, keep and revert atomically retain complete build/data pairs", async () => {
  const options = await fixture();
  const first = await options.pair("first");
  const next = await options.pair("next");
  const store = await openPointerStore({ ...options, initial: first });
  expect((await store.read()).current).toEqual(first);
  await store.beginTrial({ pair: next, switchId: "switch-1", candidateToken: "candidate-1" });
  const trial = await store.read();
  expect(trial.current).toEqual(first);
  expect(trial.trial?.pair).toEqual(next);
  await store.keep({ switchId: "switch-1", candidateToken: "candidate-1" });
  const kept = await store.read();
  expect(kept).toMatchObject({ seq: 2, current: next, previous: first, trial: null });
  const third = await options.pair("third");
  await store.beginTrial({ pair: third, switchId: "switch-2", candidateToken: "candidate-2" });
  await store.revert({ switchId: "switch-2", candidateToken: "candidate-2" });
  expect(await store.read()).toMatchObject({ seq: 4, current: next, previous: first, trial: null });
  expect(JSON.parse(await readFile(options.filename, "utf8"))).toEqual(await store.read());
  await expect(
    store.beginTrial({ pair: first, switchId: "rollback", candidateToken: "rollback-token" }),
  ).rejects.toMatchObject({ code: "state_conflict" });
  const copied = await executeEpochCopy(
    await planEpochCopy({
      sourceHome: path.join(options.home, "data", first.dataId),
      dataRoot: path.join(options.home, "data"),
      dataId: "rollback",
      buildId: first.buildId,
      shared: {
        plugins: path.join(options.home, "plugins"),
        worktrees: path.join(options.home, "worktrees"),
        models: path.join(options.home, "models/local-speech"),
      },
      policy: { schemaVersion: 1, entries: {} },
    }),
  );
  const rollback = { ...first, dataId: copied.dataId };
  await store.beginTrial({
    pair: rollback,
    switchId: "rollback",
    candidateToken: "rollback-token",
  });
  await store.keep({ switchId: "rollback", candidateToken: "rollback-token" });
  expect(await store.read()).toMatchObject({
    seq: 6,
    current: rollback,
    previous: next,
    trial: null,
  });
});

test("concurrent requests serialize and stale trial decisions leave the selected pair unchanged", async () => {
  const options = await fixture();
  const first = await options.pair("first");
  const next = await options.pair("next");
  const store = await openPointerStore({ ...options, initial: first });
  const results = await Promise.allSettled([
    store.beginTrial({ pair: next, switchId: "one", candidateToken: "candidate" }),
    store.beginTrial({ pair: next, switchId: "two", candidateToken: "candidate" }),
  ]);
  expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
  const before = await readFile(options.filename, "utf8");
  await expect(store.keep({ switchId: "two", candidateToken: "candidate" })).rejects.toMatchObject({
    code: "state_conflict",
  });
  expect(await readFile(options.filename, "utf8")).toBe(before);
  await store.revert({ switchId: "one", candidateToken: "candidate" });
  expect(await store.read()).toMatchObject({ seq: 2, current: first, trial: null });
});

test("another writer invalidates the store, including edits that do not advance seq", async () => {
  const options = await fixture();
  const first = await options.pair("first");
  const next = await options.pair("next");
  const store = await openPointerStore({ ...options, initial: first });
  const competing = await openPointerStore({ ...options, writerToken: "second-controller" });
  await competing.beginTrial({ pair: next, switchId: "one", candidateToken: "candidate" });
  const before = await readFile(options.filename, "utf8");
  await expect(store.keep({ switchId: "one", candidateToken: "candidate" })).rejects.toMatchObject({
    code: "state_conflict",
  });
  await expect(
    store.revert({ switchId: "one", candidateToken: "candidate" }),
  ).rejects.toMatchObject({ code: "state_conflict" });
  expect(await readFile(options.filename, "utf8")).toBe(before);
  await writeFile(options.filename, `${before}\n`);
  await expect(
    competing.keep({ switchId: "one", candidateToken: "candidate" }),
  ).rejects.toMatchObject({ code: "state_conflict" });
  expect(await readFile(options.filename, "utf8")).toBe(`${before}\n`);
});

test("compatible future fields survive trial and keep without changing reader requirements", async () => {
  const options = await fixture();
  const first = await options.pair("first");
  const next = await options.pair("next");
  const original = await openPointerStore({ ...options, initial: first });
  const state = await original.read();
  await original.seal();
  await writeJsonAtomic({
    filename: options.filename,
    value: {
      ...state,
      schemaVersion: 2,
      future: { preserved: ["value"] },
      current: { ...first, label: "original" },
      writer: { ...state.writer, note: "retained" },
    },
  });
  const store = await openPointerStore(options);
  const returned = await store.beginTrial({
    pair: { ...next, label: "candidate" },
    switchId: "one",
    candidateToken: "candidate",
  });
  returned.seq = 500;
  returned.current.dataId = "external-mutation";
  await store.keep({ switchId: "one", candidateToken: "candidate" });
  expect(await store.read()).toMatchObject({
    seq: 2,
    schemaVersion: 2,
    minReaderVersion: 1,
    future: { preserved: ["value"] },
    current: { ...next, label: "candidate" },
    previous: { ...first, label: "original" },
    writer: { pid: process.pid, token: options.writerToken },
  });
  expect((await store.read()).writer).not.toHaveProperty("note");
  await store.seal();
  const newer = { ...JSON.parse(await readFile(options.filename, "utf8")), minReaderVersion: 2 };
  await writeJsonAtomic({ filename: options.filename, value: newer });
  const before = await readFile(options.filename, "utf8");
  await expect(openPointerStore(options)).rejects.toMatchObject({ code: "unsupported_schema" });
  expect(await readFile(options.filename, "utf8")).toBe(before);
});

test("seal drains accepted writes and rejects new requests before handing off ownership", async () => {
  const options = await fixture();
  const first = await options.pair("first");
  const next = await options.pair("next");
  const store = await openPointerStore({ ...options, initial: first });
  const accepted = store.beginTrial({ pair: next, switchId: "one", candidateToken: "candidate" });
  const sealed = store.seal();
  await expect(store.keep({ switchId: "one", candidateToken: "candidate" })).rejects.toMatchObject({
    code: "store_sealed",
  });
  await sealed;
  expect(await accepted).toMatchObject({ seq: 1, current: first, trial: { pair: next } });
  expect(JSON.parse(await readFile(options.filename, "utf8"))).toMatchObject({
    seq: 1,
    current: first,
  });
});

test("future writer requirements allow inspection but reject every state transition", async () => {
  const options = await fixture();
  const first = await options.pair("first");
  const next = await options.pair("next");
  const original = await openPointerStore({ ...options, initial: first });
  await original.beginTrial({ pair: next, switchId: "one", candidateToken: "candidate" });
  const state = await original.read();
  await original.seal();
  await writeJsonAtomic({
    filename: options.filename,
    value: { ...state, schemaVersion: 2, minWriterVersion: 2 },
  });
  const store = await openPointerStore(options);
  expect((await store.read()).minWriterVersion).toBe(2);
  const before = await readFile(options.filename, "utf8");
  await expect(
    store.beginTrial({ pair: next, switchId: "two", candidateToken: "candidate" }),
  ).rejects.toMatchObject({ code: "unsupported_schema" });
  await expect(store.keep({ switchId: "one", candidateToken: "candidate" })).rejects.toMatchObject({
    code: "unsupported_schema",
  });
  await expect(
    store.revert({ switchId: "one", candidateToken: "candidate" }),
  ).rejects.toMatchObject({ code: "unsupported_schema" });
  expect(await readFile(options.filename, "utf8")).toBe(before);
});

test("revert requires the exact candidate and remains available with damaged epoch manifests", async () => {
  const options = await fixture();
  const first = await options.pair("first");
  const next = await options.pair("next");
  const store = await openPointerStore({ ...options, initial: first });
  await store.beginTrial({ pair: next, switchId: "one", candidateToken: "candidate" });
  const before = await readFile(options.filename, "utf8");
  await expect(store.keep({ switchId: "one", candidateToken: "wrong" })).rejects.toMatchObject({
    code: "state_conflict",
  });
  await expect(store.revert({ switchId: "one", candidateToken: "wrong" })).rejects.toMatchObject({
    code: "state_conflict",
  });
  expect(await readFile(options.filename, "utf8")).toBe(before);
  await store.seal();
  await writeFile(path.join(options.home, "data/first/epoch.json"), "corrupted");
  await rm(path.join(options.home, "data/next/epoch.json"));
  const recovered = await openPointerStore(options);
  await recovered.revert({ switchId: "one", candidateToken: "candidate" });
  expect(await recovered.read()).toMatchObject({ seq: 2, current: first, trial: null });
});

test("pointer state rejects symlink redirection and malformed JSON without overwriting it", async () => {
  const options = await fixture();
  const first = await options.pair("first");
  const store = await openPointerStore({ ...options, initial: first });
  await store.seal();
  const runner = path.dirname(options.filename);
  const outside = path.join(path.dirname(options.home), "external-runner");
  await rename(runner, outside);
  await symlink(outside, runner, "junction");
  await expect(openPointerStore(options)).rejects.toMatchObject({ code: "unsafe_path" });
  await rm(runner);
  await rename(outside, runner);
  await writeFile(options.filename, "{broken");
  await expect(openPointerStore(options)).rejects.toMatchObject({ code: "invalid_state" });
  expect(await readFile(options.filename, "utf8")).toBe("{broken");
});

test("losing the ownership lease before commit leaves the file intact and prevents retry", async () => {
  const options = await fixture();
  const first = await options.pair("first");
  const next = await options.pair("next");
  let remainingChecks = Infinity;
  const store = await openPointerStore({
    ...options,
    initial: first,
    assertOwned() {
      if (--remainingChecks < 0) throw new StorageError("lease_lost", "Test lease expired");
    },
  });
  const before = await readFile(options.filename, "utf8");
  remainingChecks = 1;
  await expect(
    store.beginTrial({ pair: next, switchId: "one", candidateToken: "candidate" }),
  ).rejects.toMatchObject({ code: "lease_lost" });
  remainingChecks = Infinity;
  await expect(
    store.beginTrial({ pair: next, switchId: "two", candidateToken: "candidate" }),
  ).rejects.toMatchObject({ code: "state_conflict" });
  expect(await readFile(options.filename, "utf8")).toBe(before);
  expect(await readdir(path.dirname(options.filename))).toEqual(["current.json"]);
});

test("rejects unfinished, mismatched and shared-current epochs before publishing a trial", async () => {
  const options = await fixture();
  const first = await options.pair("first");
  const next = await options.pair("next");
  const store = await openPointerStore({ ...options, initial: first });
  const before = await readFile(options.filename, "utf8");
  const trial = { switchId: "one", candidateToken: "candidate" };
  await expect(store.beginTrial({ ...trial, pair: first })).rejects.toMatchObject({
    code: "state_conflict",
  });
  await expect(
    store.beginTrial({ ...trial, pair: { ...first, dataId: next.dataId } }),
  ).rejects.toMatchObject({ code: "identity_conflict" });
  await expect(async () =>
    store.beginTrial({ ...trial, pair: { ...next, dataId: "next.partial" } }),
  ).rejects.toThrow();
  await rm(path.join(options.home, "data/next/epoch.json"));
  await expect(store.beginTrial({ ...trial, pair: next })).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(options.filename, "utf8")).toBe(before);
});

test("cannot select an epoch linked outside the runtime home", async () => {
  const options = await fixture();
  const first = await options.pair("first");
  const next = await options.pair("next");
  const store = await openPointerStore({ ...options, initial: first });
  const epoch = path.join(options.home, "data/next");
  const external = path.join(path.dirname(options.home), "external-epoch");
  await rename(epoch, external);
  await symlink(external, epoch, "junction");
  await expect(
    store.beginTrial({ pair: next, switchId: "one", candidateToken: "candidate" }),
  ).rejects.toMatchObject({ code: "unsafe_path" });
  expect(await store.read()).toMatchObject({ seq: 0, current: first, trial: null });
});

test("create-once JSON publication elects one complete winner without replacing it", async () => {
  const options = await fixture();
  const values = [{ owner: "first" }, { owner: "second" }];
  const results = await Promise.allSettled(
    values.map((value) =>
      writeJsonAtomic({
        filename: options.filename,
        value,
        mode: "publish",
      }),
    ),
  );
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  const winner = results.findIndex((result) => result.status === "fulfilled");
  expect(JSON.parse(await readFile(options.filename, "utf8"))).toEqual(values[winner]);
  expect(await readdir(path.dirname(options.filename))).toEqual(["current.json"]);
});
