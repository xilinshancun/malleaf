import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { matchesRegisteredInstance, openInstanceLedger } from "./instances.js";
import { StorageError } from "../storage.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "malleaf-ledger-"));
  roots.push(home);
  const options = { home, assertOwned() {} };
  const ledger = await openInstanceLedger(options);
  const launch = {
    home: path.join(home, "data/one"),
    buildId: "a".repeat(64),
    token: randomUUID(),
  };
  const instance = {
    pid: 12345,
    startedAt: new Date().toISOString(),
    hostname: "fixture",
    uid: 501,
    listen: null,
  };
  return {
    ...options,
    ledger,
    launch,
    instance,
    filename: path.join(home, "runner/instances.json"),
  };
}

test("intent alone cannot authorize adoption and an acquired identity cannot be replaced", async () => {
  const { ledger, launch, instance } = await fixture();
  await ledger.intent("candidate", launch);
  const pending = (await ledger.read()).registrations.candidate!;
  expect(matchesRegisteredInstance(pending, pending.home, instance)).toBe(false);
  await ledger.acquired("candidate", launch.token, instance);
  const recorded = (await ledger.read()).registrations.candidate!;
  expect(matchesRegisteredInstance(recorded, recorded.home, instance)).toBe(true);
  expect(
    matchesRegisteredInstance(recorded, recorded.home, { ...instance, startedAt: "later" }),
  ).toBe(false);
  await expect(
    ledger.acquired("candidate", launch.token, { ...instance, pid: 12346 }),
  ).rejects.toMatchObject({ code: "state_conflict" });
  await expect(ledger.clear("candidate", randomUUID())).rejects.toMatchObject({
    code: "state_conflict",
  });
  await ledger.promote(launch.token);
  expect((await ledger.read()).registrations).toEqual({ baseline: recorded });
});

test("future fields survive but newer writer requirements prevent mutation", async () => {
  const options = await fixture();
  await options.ledger.seal();
  const before = JSON.parse(await readFile(options.filename, "utf8"));
  await writeFile(
    options.filename,
    JSON.stringify({ ...before, schemaVersion: 2, future: { preserve: true } }),
  );
  const compatible = await openInstanceLedger(options);
  await compatible.intent("baseline", options.launch);
  expect(await compatible.read()).toMatchObject({ future: { preserve: true } });
  await compatible.seal();
  const future = { ...(await compatibleState(options.filename)), minWriterVersion: 2 };
  await writeFile(options.filename, JSON.stringify(future));
  const readOnly = await openInstanceLedger(options);
  expect((await readOnly.read()).minWriterVersion).toBe(2);
  await expect(readOnly.clear("baseline", options.launch.token)).rejects.toMatchObject({
    code: "unsupported_schema",
  });
  expect(JSON.parse(await readFile(options.filename, "utf8"))).toEqual(future);
});
async function compatibleState(filename: string) {
  return JSON.parse(await readFile(filename, "utf8"));
}

test("external edits poison the writer and sealed stores refuse further work", async () => {
  const options = await fixture();
  const second = await openInstanceLedger(options);
  await second.intent("baseline", options.launch);
  await expect(
    options.ledger.intent("candidate", { ...options.launch, token: randomUUID() }),
  ).rejects.toMatchObject({ code: "state_conflict" });
  await expect(options.ledger.read()).rejects.toMatchObject({ code: "state_conflict" });
  await second.seal();
  await expect(second.clear("baseline", options.launch.token)).rejects.toMatchObject({
    code: "store_sealed",
  });
});

test("lease loss before publication leaves bytes unchanged and poisons subsequent operations", async () => {
  const options = await fixture();
  let checks = 0;
  let fail = false;
  const store = await openInstanceLedger({
    ...options,
    assertOwned() {
      if (fail && ++checks === 2) throw new StorageError("lease_lost", "injected");
    },
  });
  const before = await readFile(options.filename, "utf8");
  fail = true;
  await expect(store.intent("baseline", options.launch)).rejects.toMatchObject({
    code: "lease_lost",
  });
  expect(await readFile(options.filename, "utf8")).toBe(before);
  await expect(store.read()).rejects.toMatchObject({ code: "state_conflict" });
});

test("runner symlinks cannot redirect the ledger outside the product home", async () => {
  const options = await fixture();
  await options.ledger.seal();
  await rm(path.join(options.home, "runner"), { recursive: true });
  const external = path.join(options.home, "external");
  await mkdir(external);
  await symlink(external, path.join(options.home, "runner"), "junction");
  await expect(openInstanceLedger(options)).rejects.toMatchObject({ code: "unsafe_path" });
});
