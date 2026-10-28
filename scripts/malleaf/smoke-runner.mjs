#!/usr/bin/env node
// Stable-entry acceptance only in a new disposable mock home.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { preparePreflight } from "../../packages/malleaf-controller/dist/runtime/preflight.js";
import {
  materializeSlot,
  verifySlot,
} from "../../packages/malleaf-controller/dist/slot/materialize.js";
import {
  executeEpochCopy,
  planEpochCopy,
} from "../../packages/malleaf-controller/dist/data/epoch.js";
import { initializeRuntime } from "../../packages/malleaf-controller/dist/runner/initialize.js";
import { installStableRunner } from "../../packages/malleaf-controller/dist/runner/install.js";
import {
  acquireControlLease,
  identifyController,
} from "../../packages/malleaf-controller/dist/runner/lease.js";
import { openInstanceLedger } from "../../packages/malleaf-controller/dist/runner/instances.js";
import { stopRuntimeInstance } from "../../packages/malleaf-controller/dist/runtime/daemon.js";
import {
  readDaemonInstance,
  isSameDaemonInstance,
} from "../../packages/server/dist/server/server/daemon-instance.js";
import { bindControllerBuild, captureHostState, assertNoSlotProcesses } from "./smoke-audit.mjs";

assert.ok(process.argv[2], "Usage: smoke-runner.mjs <verified-physical-slot>");
const sourceSlot = path.resolve(process.argv[2]);
const source = await verifySlot({
  directory: sourceSlot,
  expectedBuildId: path.basename(sourceSlot),
  mode: "full",
});
const binding = await bindControllerBuild(source);
const hostBefore = await captureHostState();
const prepared = await preparePreflight({ slotDirectory: sourceSlot, mockProvider: true });
const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "malleaf-runner-evidence-"));
process.stderr.write(`Acceptance: ${prepared.root}\nEvidence: ${evidenceRoot}\n`);
const shared = Object.fromEntries(
  ["plugins", "worktrees", "models"].map((name) => [name, path.join(prepared.home, name)]),
);
for (const directory of Object.values(shared)) await mkdir(directory, { recursive: true });
const slot = await materializeSlot({
  sourceRoot: sourceSlot,
  versionsRoot: path.join(prepared.home, "versions"),
  paths: source.files.map((file) => file.path),
  entries: source.entries,
  provenance: source.provenance,
});
const pair = { buildId: slot.manifest.buildId, dataId: "baseline" };
await executeEpochCopy(
  await planEpochCopy({
    sourceHome: prepared.daemonHome,
    dataRoot: path.join(prepared.home, "data"),
    ...pair,
    shared,
    policy: { schemaVersion: 1, entries: {} },
  }),
);
const initialized = await initializeRuntime({ home: prepared.home, initialPair: pair });
const installed = await installStableRunner({ home: prepared.home });
assert.equal(installed.status, "installed");
assert.equal((await installStableRunner({ home: prepared.home })).status, "already_installed");
const children = [];
const stages = [];
const daemonHome = path.join(prepared.home, "data", pair.dataId);
const ledgerFile = path.join(prepared.home, "runner/instances.json");
let expectedInstance;
let failure;
let hostAfter;
let remainingSlotProcesses;

function launch(entry, name, admission) {
  const args = [entry, "--home", prepared.home, "--acceptance-root", prepared.root];
  if (admission) args.push("--control-port", String(initialized.controlPort));
  const environment = { ...prepared.env, TMPDIR: os.tmpdir(), TMP: os.tmpdir(), TEMP: os.tmpdir() };
  delete environment.MALLEAF_SLOT_MANIFEST;
  delete environment.MALLEAF_CLI;
  delete environment.MALLEAF_DAEMON_HOME;
  const child = spawn(process.execPath, args, {
    env: environment,
    stdio: admission ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
  });
  const record = {
    child,
    name,
    stdout: "",
    stderr: "",
    ready: null,
    exited: false,
    ipcDetached: false,
  };
  children.push(record);
  child.stdout.on("data", (chunk) => {
    record.stdout += String(chunk);
    for (const line of record.stdout.split("\n")) {
      try {
        const message = JSON.parse(line);
        if (message.type === "malleaf.controller.ready") record.ready = message;
      } catch {
        /* Daemon/controller diagnostics may also use stdout. */
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    record.stderr += String(chunk);
  });
  record.exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      record.exited = true;
      resolve({ code, signal });
    });
  });
  void record.exit.catch(() => {});
  if (admission)
    child.on("message", (message) => {
      if (message?.type !== "malleaf.controller.loaded") return;
      if (message.buildId !== pair.buildId) {
        record.protocolError = new Error("Controller IPC identity mismatch");
        child.disconnect();
        return;
      }
      if (admission === "disconnect-before") {
        child.disconnect();
        record.ipcDetached = true;
      } else
        child.send({ type: "malleaf.controller.proceed", attempt: randomUUID() }, (error) => {
          if (error) {
            record.protocolError = error;
            return;
          }
          child.disconnect();
          record.ipcDetached = true;
        });
    });
  return record;
}

async function ready(record) {
  const deadline = Date.now() + 90_000;
  while (!record.ready) {
    if (record.protocolError) throw record.protocolError;
    assert.equal(record.exited, false, `Controller exited before readiness: ${record.stderr}`);
    assert.ok(Date.now() < deadline, `Controller readiness timed out: ${record.stderr}`);
    await delay(50);
  }
  const identity = await identifyController({ port: initialized.controlPort });
  assert.equal(identity?.pid, record.ready.pid);
  const registered = JSON.parse(await readFile(ledgerFile, "utf8")).registrations.baseline;
  assert.ok(registered?.instance);
  const live = await readDaemonInstance(daemonHome);
  assert.ok(live && isSameDaemonInstance(registered.instance, live));
  if (expectedInstance)
    assert.ok(
      isSameDaemonInstance(expectedInstance, live),
      "Controller recovery must retain the existing daemon",
    );
  expectedInstance = live;
  stages.push({ name: record.name, ready: record.ready, identity, daemon: live });
}

async function stopChild(record) {
  if (!record.exited) record.child.kill("SIGTERM"); // Only our direct child handle.
  const deadline = Date.now() + 20_000;
  while (!record.exited) {
    assert.ok(Date.now() < deadline, `Controller did not exit: ${record.name}`);
    await delay(50);
  }
  assert.deepEqual(await record.exit, { code: 0, signal: null });
}

async function assertReleased(ledgerBefore) {
  assert.equal(await identifyController({ port: initialized.controlPort, timeoutMs: 500 }), null);
  const owner = await acquireControlLease({
    home: prepared.home,
    port: initialized.controlPort,
    buildId: pair.buildId,
    role: "init",
  });
  await owner.release({ seal: async () => {} });
  assert.equal(await readFile(ledgerFile, "utf8"), ledgerBefore);
  const live = await readDaemonInstance(daemonHome);
  assert.ok(
    live && isSameDaemonInstance(expectedInstance, live),
    "Controller exit must leave the registered daemon alive",
  );
}

try {
  for (const name of ["installed-runner-first", "installed-runner-reattach"]) {
    const child = launch(installed.filename, name);
    await ready(child);
    const ledgerBefore = await readFile(ledgerFile, "utf8");
    await stopChild(child);
    await assertReleased(ledgerBefore);
  }
  const entry = path.join(slot.directory, slot.manifest.entries.controller);
  const ledgerBefore = await readFile(ledgerFile, "utf8");
  const unacknowledged = launch(entry, "disconnect-before-ack", "disconnect-before");
  const deadline = Date.now() + 20_000;
  while (!unacknowledged.exited) {
    if (unacknowledged.protocolError) throw unacknowledged.protocolError;
    assert.ok(Date.now() < deadline);
    await delay(50);
  }
  assert.deepEqual(await unacknowledged.exit, { code: 0, signal: null });
  assert.equal(unacknowledged.ready, null);
  await assertReleased(ledgerBefore);
  const detached = launch(entry, "disconnect-after-ack", "disconnect-after");
  await ready(detached);
  assert.equal(detached.ipcDetached, true);
  await delay(200);
  assert.equal(detached.exited, false);
  await stopChild(detached);
  await assertReleased(ledgerBefore);
} catch (error) {
  failure = error;
}

try {
  const childErrors = [];
  for (const child of children) await stopChild(child).catch((error) => childErrors.push(error));
  const owner = await acquireControlLease({
    home: prepared.home,
    port: initialized.controlPort,
    buildId: pair.buildId,
    role: "init",
  });
  const ledger = await openInstanceLedger({ home: prepared.home, assertOwned: owner.assertOwned });
  try {
    const registrations = (await ledger.read()).registrations;
    for (const [role, registration] of Object.entries(registrations)) {
      assert.ok(registration.instance, "Unresolved intent is retained for diagnosis");
      await stopRuntimeInstance({
        daemonHome: registration.home,
        instance: registration.instance,
        assertOwned: owner.assertOwned,
        clientId: randomUUID(),
      });
      assert.equal(await readDaemonInstance(registration.home), null);
      await ledger.clear(role, registration.token);
    }
    await writeFile(path.join(evidenceRoot, "instances.json"), await readFile(ledgerFile));
  } finally {
    await owner.release({ seal: ledger.seal });
  }
  if (childErrors.length) throw new AggregateError(childErrors, "Controller cleanup failed");
  assert.throws(() => process.kill(expectedInstance.pid, 0), { code: "ESRCH" });
  for (const child of children)
    assert.throws(() => process.kill(child.child.pid, 0), { code: "ESRCH" });
  for (const stage of stages)
    assert.throws(() => process.kill(stage.ready.pid, 0), { code: "ESRCH" });
  remainingSlotProcesses = await assertNoSlotProcesses(prepared.root);
  await verifySlot({ directory: sourceSlot, expectedBuildId: source.buildId, mode: "full" });
  await verifySlot({ directory: slot.directory, expectedBuildId: pair.buildId, mode: "full" });
  hostAfter = await captureHostState();
  assert.deepEqual(hostAfter, hostBefore);
} catch (cleanupError) {
  failure = failure
    ? new AggregateError([failure, cleanupError], "Runner acceptance and cleanup failed")
    : cleanupError;
}
for (const child of children) {
  await writeFile(path.join(evidenceRoot, `${child.name}.stdout.log`), child.stdout);
  await writeFile(path.join(evidenceRoot, `${child.name}.stderr.log`), child.stderr);
}
const result = {
  sourceCommit: source.provenance.sourceCommit,
  buildId: pair.buildId,
  binding,
  evidenceRoot,
  root: prepared.root,
  stages,
  hostBefore,
  hostAfter,
  remainingSlotProcesses,
  children: children.map((child) => ({
    name: child.name,
    pid: child.child.pid,
    exited: child.exited,
    ipcDetached: child.ipcDetached,
  })),
  error: failure ? String(failure) : null,
  causes: failure instanceof AggregateError ? failure.errors.map(String) : [],
};
if (failure) {
  await writeFile(path.join(evidenceRoot, "failure.json"), JSON.stringify(result, null, 2));
  throw failure;
}
async function makeRemovable(directory) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory()) await makeRemovable(path.join(directory, entry.name));
}
await makeRemovable(prepared.root);
await prepared.dispose();
Object.assign(result, {
  leaseReleased: true,
  ledgerUnchangedAcrossControllerExit: true,
  daemonRetainedAcrossControllerRestart: true,
  allObservedProcessesExited: true,
  hostMetadataUnchanged: true,
  slotUnchanged: true,
  disposed: true,
});
await writeFile(path.join(evidenceRoot, "result.json"), JSON.stringify(result, null, 2));
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
