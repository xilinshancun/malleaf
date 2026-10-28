#!/usr/bin/env node
import { evidenceJson, copyRunnerEvidence } from "./smoke-audit.mjs";
// Copied-controller handoff acceptance in disposable, mock-only product state.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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

assert.ok(process.argv[2], "Usage: smoke-handoff.mjs <verified-physical-slot>");
const sourceSlot = path.resolve(process.argv[2]);
const source = await verifySlot({
  directory: sourceSlot,
  expectedBuildId: path.basename(sourceSlot),
  mode: "full",
});
const binding = await bindControllerBuild(source);
const hostBefore = await captureHostState();
const prepared = await preparePreflight({ slotDirectory: sourceSlot, mockProvider: true });
const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "malleaf-handoff-evidence-"));
process.stderr.write(`Acceptance: ${prepared.root}\nEvidence: ${evidenceRoot}\n`);
const shared = Object.fromEntries(
  ["plugins", "worktrees", "models"].map((name) => [name, path.join(prepared.home, name)]),
);
for (const directory of Object.values(shared)) await mkdir(directory, { recursive: true });
const slots = [];
async function variant(name, transform) {
  let sourceRoot = sourceSlot;
  if (transform) {
    sourceRoot = path.join(prepared.root, `fixture-${name}`);
    await cp(sourceSlot, sourceRoot, { recursive: true, verbatimSymlinks: true });
    const entry = path.join(sourceRoot, source.entries.controller);
    await chmod(entry, 0o600);
    await writeFile(entry, transform(await readFile(entry, "utf8")));
  }
  const slot = await materializeSlot({
    sourceRoot,
    versionsRoot: path.join(prepared.home, "versions"),
    paths: source.files.map((file) => file.path),
    entries: source.entries,
    provenance: {
      ...source.provenance,
      display: `0.1.0.handoff-${name}`,
      builder: transform ? "smoke-handoff-fault-fixture" : source.provenance.builder,
      createdAt: new Date().toISOString(),
    },
  });
  slots.push(slot);
  return slot;
}
const base = await variant("baseline-notification-fixture", (code) => {
  const needle = "function sendIpc(message) {";
  assert.equal(code.split(needle).length, 2, "Notification fixture must match one send function");
  return code.replace(
    needle,
    `let failFirstHandoff = true;
function sendIpc(message) {
  if (message.type === "malleaf.controller.handoff" && failFirstHandoff) {
    failFirstHandoff = false;
    process.stderr.write("Injected handoff notification delivery failure\\n");
    return Promise.resolve(false);
  }`,
  );
});
const healthy = await variant("healthy");
const loadFailure = await variant(
  "load-failure",
  (code) => `if (!process.argv.includes("--verify")) process.exit(42);\n${code}`,
);
const verifyFailure = await variant(
  "verify-failure",
  (code) => `if (process.argv.includes("--verify")) process.exit(43);\n${code}`,
);
const acknowledgedFailure = await variant("ack-failure", (code) => {
  const needle = "const config = await verifyBootState(home, controlPort);";
  assert.equal(
    code.split(needle).length,
    2,
    "Post-ACK fixture must have one exact injection point",
  );
  return code.replace(
    needle,
    'throw new StorageError("invalid_state", "post-ACK handoff fixture");\n' + needle,
  );
});
const initial = { buildId: base.manifest.buildId, dataId: "baseline" };
await executeEpochCopy(
  await planEpochCopy({
    sourceHome: prepared.daemonHome,
    dataRoot: path.join(prepared.home, "data"),
    ...initial,
    shared,
    policy: { schemaVersion: 1, entries: {} },
  }),
);
const initialized = await initializeRuntime({ home: prepared.home, initialPair: initial });
const installed = await installStableRunner({ home: prepared.home });
const ledgerFile = path.join(prepared.home, "runner/instances.json");
const pointerFile = path.join(prepared.home, "runner/current.json");
const diagnosticFile = path.join(prepared.home, "runner/stable/last-boot.json");
const children = [];
const stages = [];
const observedPids = new Set();
let selected = initial;
let failure;
let hostAfter;
let remainingSlotProcesses;

function launch(name) {
  const environment = { ...prepared.env, TMPDIR: os.tmpdir(), TMP: os.tmpdir(), TEMP: os.tmpdir() };
  for (const key of ["MALLEAF_SLOT_MANIFEST", "MALLEAF_CLI", "MALLEAF_DAEMON_HOME"])
    delete environment[key];
  const child = spawn(
    process.execPath,
    [installed.filename, "--home", prepared.home, "--acceptance-root", prepared.root],
    { env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  const record = { child, name, stdout: "", stderr: "", messages: [], ready: [], exited: false };
  children.push(record);
  observedPids.add(child.pid);
  child.stdout.on("data", (chunk) => {
    record.stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    record.stderr += String(chunk);
  });
  child.on("message", (message) => {
    record.messages.push(message);
    if (message?.type === "malleaf.controller.ready") {
      record.ready.push(message);
      observedPids.add(message.pid);
    }
  });
  record.exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      record.exited = true;
      resolve({ code, signal });
    });
  });
  void record.exit.catch(() => {});
  return record;
}
async function until(test, record, label, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (!test()) {
    assert.equal(record.exited, false, `${label}: runner exited: ${record.stderr}`);
    assert.ok(Date.now() < deadline, `${label}: timeout: ${record.stderr}`);
    await delay(25);
  }
}
async function ready(record, count, buildId) {
  await until(() => record.ready.length >= count, record, "controller readiness");
  const value = record.ready[count - 1];
  assert.equal(value.buildId, buildId);
  const identity = await identifyController({ port: initialized.controlPort });
  assert.equal(identity?.pid, value.pid);
  assert.equal(identity?.buildId, buildId);
  return value;
}
async function command(record, name, params = {}, allowError = false) {
  const requestId = randomUUID();
  await new Promise((resolve, reject) =>
    record.child.send(
      { type: "malleaf.controller.request", requestId, command: name, params },
      (error) => (error ? reject(error) : resolve()),
    ),
  );
  await until(
    () =>
      record.messages.some(
        (m) => m.type === "malleaf.controller.result" && m.requestId === requestId,
      ),
    record,
    `${name} reply`,
    180_000,
  );
  const response = record.messages.find(
    (m) => m.type === "malleaf.controller.result" && m.requestId === requestId,
  );
  if (!allowError) assert.equal(response.ok, true, evidenceJson(response.error));
  return response;
}
async function live(pair) {
  const instance = await readDaemonInstance(path.join(prepared.home, "data", pair.dataId));
  assert.ok(instance);
  observedPids.add(instance.pid);
  return instance;
}
async function trial(record, slot, dataId) {
  const request = {
    switchId: randomUUID(),
    switchToken: randomUUID(),
    drainId: randomUUID(),
    candidate: { buildId: slot.manifest.buildId, dataId },
    copySource: selected,
  };
  const { value } = await command(record, "activate", request);
  assert.equal(value.transaction.step, "trial");
  assert.deepEqual(value.pointer.trial.pair, request.candidate);
  assert.equal(value.status.state, "accepting");
  const instance = await live(request.candidate);
  stages.push({ name: `${dataId}-trial`, value, instance });
  return { request, instance };
}
async function keep(record, attempt) {
  const { value } = await command(record, "keep", { switchId: attempt.request.switchId });
  selected = attempt.request.candidate;
  assert.deepEqual(value.pointer.current, selected);
  assert.equal(value.pointer.trial, null);
  assert.equal(value.transaction.step, "kept");
  assert.ok(isSameDaemonInstance(attempt.instance, value.instance));
  return value;
}
async function stop(record, code = 0) {
  if (!record.exited) record.child.kill("SIGTERM"); // Only our direct runner handle.
  const deadline = Date.now() + 20_000;
  while (!record.exited) {
    assert.ok(Date.now() < deadline, "Runner did not stop");
    await delay(25);
  }
  assert.deepEqual(await record.exit, { code, signal: null });
}
async function releasedWithoutDaemonChange(instance) {
  assert.equal(await identifyController({ port: initialized.controlPort, timeoutMs: 500 }), null);
  const owner = await acquireControlLease({
    home: prepared.home,
    port: initialized.controlPort,
    buildId: selected.buildId,
    role: "init",
  });
  await owner.release({ seal: async () => {} });
  assert.ok(isSameDaemonInstance(instance, await live(selected)));
}
async function diagnostic(name) {
  const bytes = await readFile(diagnosticFile);
  await writeFile(path.join(evidenceRoot, `${name}-last-boot.json`), bytes);
  return JSON.parse(bytes);
}
try {
  const first = launch("healthy-handoff");
  const before = await ready(first, 1, initial.buildId);
  const healthyTrial = await trial(first, healthy, "healthy");
  const initialKeep = await keep(first, healthyTrial);
  const stillRunning = (await command(first, "status")).value;
  assert.deepEqual(stillRunning.pointer.current, selected);
  assert.equal(first.ready.length, 1);
  assert.equal((await identifyController({ port: initialized.controlPort }))?.pid, before.pid);
  assert.ok(isSameDaemonInstance(healthyTrial.instance, stillRunning.instance));
  stages.push({
    name: "notification-delivery-failure",
    initialKeep,
    stillRunning,
    controllerPid: before.pid,
    injection: "sendIpc returns false once; real IPC remains connected",
  });
  const kept = await keep(first, healthyTrial);
  const ledgerAfterKeep = await readFile(ledgerFile, "utf8");
  const after = await ready(first, 2, selected.buildId);
  assert.notEqual(before.pid, after.pid);
  assert.ok(isSameDaemonInstance(healthyTrial.instance, await live(selected)));
  assert.equal(await readFile(ledgerFile, "utf8"), ledgerAfterKeep);
  stages.push({
    name: "healthy-handoff",
    before,
    after,
    kept,
    daemonUnchanged: true,
    ledgerUnchanged: true,
  });
  await stop(first);
  await releasedWithoutDaemonChange(healthyTrial.instance);
  assert.deepEqual(
    (await diagnostic(first.name)).attempts.map((a) => [a.reason, a.code]),
    [
      ["boot", 75],
      ["handoff", 0],
    ],
  );

  const second = launch("fallback-and-post-ack");
  await ready(second, 1, selected.buildId);
  const failingTrial = await trial(second, loadFailure, "load-failure");
  await keep(second, failingTrial);
  const fallback = await ready(second, 2, healthy.manifest.buildId);
  assert.ok(isSameDaemonInstance(failingTrial.instance, await live(selected)));
  assert.deepEqual(JSON.parse(await readFile(pointerFile, "utf8")).current, selected);
  stages.push({
    name: "copied-controller-fallback",
    fallback,
    selected,
    instance: failingTrial.instance,
  });

  const failedVerify = {
    switchId: randomUUID(),
    switchToken: randomUUID(),
    drainId: randomUUID(),
    candidate: { buildId: verifyFailure.manifest.buildId, dataId: "verify-failure" },
    copySource: selected,
  };
  const verifyResult = await command(second, "activate", failedVerify, true);
  assert.equal(verifyResult.ok, false);
  assert.match(verifyResult.error.message, /self-check failed.*exit=43/);
  const status = (await command(second, "status")).value;
  assert.equal(status.transaction.step, "aborted");
  assert.equal(status.pointer.trial, null);
  assert.ok(isSameDaemonInstance(failingTrial.instance, await live(selected)));
  const registrations = JSON.parse(await readFile(ledgerFile, "utf8")).registrations;
  assert.deepEqual(Object.keys(registrations), ["baseline"]);
  stages.push({ name: "self-check-before-drain", verifyResult, status, baselineUnchanged: true });

  const postAck = await trial(second, acknowledgedFailure, "post-ack-failure");
  await keep(second, postAck);
  const deadline = Date.now() + 90_000;
  while (!second.exited) {
    assert.ok(Date.now() < deadline, "Post-ACK controller did not exit");
    await delay(25);
  }
  assert.deepEqual(await second.exit, { code: 65, signal: null });
  assert.match(second.stderr, /post-ACK handoff fixture/);
  await releasedWithoutDaemonChange(postAck.instance);
  const attempts = (await diagnostic(second.name)).attempts;
  assert.deepEqual(
    attempts.map((a) => [a.reason, a.code, a.loaded]),
    [
      ["boot", 75, true],
      ["handoff", 42, false],
      ["fallback", 75, true],
      ["handoff", 65, true],
    ],
  );
  assert.equal(second.ready.length, 2, "No fallback may follow a post-ACK failure");
  stages.push({ name: "post-ACK-no-fallback", instance: postAck.instance, attempts });
} catch (error) {
  failure = error;
}

try {
  const errors = [];
  for (const child of children)
    if (!child.exited) await stop(child).catch((error) => errors.push(error));
  const owner = await acquireControlLease({
    home: prepared.home,
    port: initialized.controlPort,
    buildId: selected.buildId,
    role: "init",
  });
  const ledger = await openInstanceLedger({ home: prepared.home, assertOwned: owner.assertOwned });
  try {
    for (const [role, registration] of Object.entries((await ledger.read()).registrations)) {
      if (!registration.instance) {
        errors.push(new Error(`Unresolved ${role} intent retained`));
        continue;
      }
      try {
        observedPids.add(registration.instance.pid);
        await stopRuntimeInstance({
          daemonHome: registration.home,
          controllerToken: registration.controllerToken,
          instance: registration.instance,
          assertOwned: owner.assertOwned,
          clientId: randomUUID(),
        });
        assert.equal(await readDaemonInstance(registration.home), null);
        await ledger.clear(role, registration.token);
      } catch (error) {
        errors.push(error);
      }
    }
    await writeFile(
      path.join(evidenceRoot, "instances.json"),
      evidenceJson(JSON.parse(await readFile(ledgerFile, "utf8"))),
    );
  } finally {
    await owner.release({ seal: ledger.seal });
  }
  if (errors.length) throw new AggregateError(errors, "Handoff cleanup was incomplete");
  for (const pid of observedPids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  remainingSlotProcesses = await assertNoSlotProcesses(prepared.root);
  for (const slot of slots)
    await verifySlot({
      directory: slot.directory,
      expectedBuildId: slot.manifest.buildId,
      mode: "full",
    });
  await verifySlot({ directory: sourceSlot, expectedBuildId: source.buildId, mode: "full" });
  hostAfter = await captureHostState();
  assert.deepEqual(hostAfter, hostBefore);
} catch (error) {
  failure = failure
    ? new AggregateError([failure, error], "Handoff acceptance and cleanup failed")
    : error;
}
for (const child of children) {
  await writeFile(path.join(evidenceRoot, `${child.name}.stdout.log`), child.stdout);
  await writeFile(path.join(evidenceRoot, `${child.name}.stderr.log`), child.stderr);
}
await copyRunnerEvidence(prepared.home, path.join(evidenceRoot, "runner"));
const result = {
  sourceCommit: source.provenance.sourceCommit,
  binding,
  root: prepared.root,
  evidenceRoot,
  stages,
  slots: slots.map((s) => ({ buildId: s.manifest.buildId, provenance: s.manifest.provenance })),
  hostBefore,
  hostAfter,
  remainingSlotProcesses,
  observedPids: [...observedPids],
  children: children.map((c) => ({
    name: c.name,
    pid: c.child.pid,
    ready: c.ready,
    messages: c.messages,
    exited: c.exited,
  })),
  error: failure ? String(failure) : null,
  causes: failure instanceof AggregateError ? failure.errors.map(String) : [],
};
if (failure) {
  await writeFile(path.join(evidenceRoot, "failure.json"), evidenceJson(result, null, 2));
  throw failure;
}
async function makeRemovable(directory) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory() && !entry.isSymbolicLink())
      await makeRemovable(path.join(directory, entry.name));
}
await makeRemovable(prepared.root);
await prepared.dispose();
Object.assign(result, {
  disposed: true,
  allObservedProcessesExited: true,
  hostMetadataUnchanged: true,
  slotUnchanged: true,
});
await writeFile(path.join(evidenceRoot, "result.json"), evidenceJson(result, null, 2));
process.stdout.write(`${evidenceJson(result, null, 2)}\n`);
