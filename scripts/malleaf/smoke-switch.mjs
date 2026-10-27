#!/usr/bin/env node
// Journalled activation acceptance in a new mock-only temporary product home.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { preparePreflight } from "../../packages/malleaf-controller/dist/runtime/preflight.js";
import { createIsolatedActivation } from "../../packages/malleaf-controller/dist/runtime/activation.js";
import { stopRuntimeInstance } from "../../packages/malleaf-controller/dist/runtime/daemon.js";
import {
  materializeSlot,
  verifySlot,
} from "../../packages/malleaf-controller/dist/slot/materialize.js";
import {
  executeEpochCopy,
  planEpochCopy,
} from "../../packages/malleaf-controller/dist/data/epoch.js";
import { initializeRuntime } from "../../packages/malleaf-controller/dist/runner/initialize.js";
import { acquireControlLease } from "../../packages/malleaf-controller/dist/runner/lease.js";
import { openPointerStore } from "../../packages/malleaf-controller/dist/runner/pointer.js";
import { openSwitchJournal } from "../../packages/malleaf-controller/dist/runner/journal.js";
import { openInstanceLedger } from "../../packages/malleaf-controller/dist/runner/instances.js";
import { readDaemonInstance } from "../../packages/server/dist/server/server/daemon-instance.js";

if (!process.argv[2])
  throw new Error("Usage: node scripts/malleaf/smoke-switch.mjs <verified-physical-slot>");
const sourceSlot = path.resolve(process.argv[2]);
const source = await verifySlot({
  directory: sourceSlot,
  expectedBuildId: path.basename(sourceSlot),
  mode: "full",
});
const prepared = await preparePreflight({ slotDirectory: sourceSlot, mockProvider: true });
const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "malleaf-switch-evidence-"));
process.stderr.write(`Acceptance: ${prepared.root}\nEvidence: ${evidenceRoot}\n`);
const shared = Object.fromEntries(
  ["plugins", "worktrees", "models"].map((name) => [name, path.join(prepared.home, name)]),
);
for (const directory of Object.values(shared)) await mkdir(directory, { recursive: true });
const policy = { schemaVersion: 1, entries: {} };
const versionsRoot = path.join(prepared.home, "versions");
const manifests = [];
async function variant(display, sourceRoot = sourceSlot) {
  const slot = await materializeSlot({
    sourceRoot,
    versionsRoot,
    paths: source.files.map((file) => file.path),
    entries: source.entries,
    provenance: { ...source.provenance, display, createdAt: new Date().toISOString() },
  });
  manifests.push(slot.manifest);
  return slot;
}
const baseSlot = await variant("0.1.0.switch-baseline");
const nextSlot = await variant("0.1.0.switch-candidate");
// A deliberate custom slot behaves normally during disposable preflight, but
// fails only for the named production-test epoch. Its changed files are hashed
// into a distinct manifest; no published artifact is modified in place.
const faultSource = path.join(prepared.root, "fault-source");
await cp(sourceSlot, faultSource, { recursive: true, verbatimSymlinks: true });
const supervisor = path.join(faultSource, source.entries.supervisor);
await chmod(supervisor, 0o600);
await writeFile(
  supervisor,
  `if (process.env.MALLEAF_DAEMON_HOME?.endsWith("startup-fail")) process.exit(42);\n${await readFile(supervisor, "utf8")}`,
);
const quiesce = path.join(faultSource, "packages/server/dist/server/server/malleaf/quiesce.js");
const quiesceSource = await readFile(quiesce, "utf8");
assert.ok(quiesceSource.includes("let shutdown = false;"));
await chmod(quiesce, 0o600);
await writeFile(
  quiesce,
  quiesceSource.replace(
    "let shutdown = false;",
    'let shutdown = process.env.MALLEAF_DAEMON_HOME?.endsWith("probe-fail") === true;',
  ),
);
const faultSlot = await variant("0.1.0.switch-fault-fixture", faultSource);
await writeFile(path.join(prepared.daemonHome, "retained-note.txt"), "original epoch bytes\n");
const baseline = { buildId: baseSlot.manifest.buildId, dataId: "baseline" };
await executeEpochCopy(
  await planEpochCopy({
    sourceHome: prepared.daemonHome,
    dataRoot: path.join(prepared.home, "data"),
    ...baseline,
    shared,
    policy,
  }),
);
const initialized = await initializeRuntime({ home: prepared.home, initialPair: baseline });
const lease = await acquireControlLease({
  home: prepared.home,
  port: initialized.controlPort,
  buildId: baseline.buildId,
  role: "controller",
});
await lease.publishIdentity();
const pointer = await openPointerStore({
  home: prepared.home,
  writerToken: randomUUID(),
  assertOwned: lease.assertOwned,
});
const journal = await openSwitchJournal({ home: prepared.home, assertOwned: lease.assertOwned });
const ledger = await openInstanceLedger({ home: prepared.home, assertOwned: lease.assertOwned });
const options = {
  acceptanceRoot: prepared.root,
  home: prepared.home,
  environment: prepared.env,
  pointer,
  journal,
  ledger,
  shared,
  policy,
  assertOwned: lease.assertOwned,
  drainDeadlineMs: 30_000,
};
let controller = await createIsolatedActivation(options);
let current;
const stages = [];
const pids = new Set();
async function record(label, result) {
  current = result;
  if (result.runtime) pids.add(result.runtime.instance.pid);
  const snapshot = {
    label,
    at: new Date().toISOString(),
    pointer: result.pointer,
    transaction: result.transaction,
    instance: result.runtime?.instance,
    identity: result.runtime?.info.malleaf,
    status: result.runtime
      ? await result.runtime.client.quiesceDaemon({ action: "status", deadlineMs: 1000 })
      : null,
  };
  stages.push(snapshot);
  await writeFile(path.join(evidenceRoot, "stages.json"), JSON.stringify(stages, null, 2));
  process.stderr.write(`${label}: ${result.transaction?.step ?? "current"}\n`);
  return result;
}
function request(candidate, copySource = current.pointer.current) {
  return {
    candidate,
    copySource,
    switchId: randomUUID(),
    switchToken: randomUUID(),
    drainId: randomUUID(),
  };
}
async function note(pair) {
  return readFile(path.join(prepared.home, "data", pair.dataId, "retained-note.txt"), "utf8");
}
async function reopen() {
  await controller.disconnect();
  controller = await createIsolatedActivation(options);
  return controller.recover();
}
async function capture() {
  await writeFile(path.join(evidenceRoot, "manifests.json"), JSON.stringify(manifests, null, 2));
  await cp(path.join(prepared.home, "runner"), path.join(evidenceRoot, "runner"), {
    recursive: true,
  });
  for (const name of await readdir(path.join(prepared.home, "data"))) {
    const home = path.join(prepared.home, "data", name);
    if (!(await lstat(home)).isDirectory()) continue;
    const destination = path.join(evidenceRoot, name);
    await mkdir(destination, { recursive: true });
    for (const filename of await readdir(home)) {
      if (filename.endsWith(".log") || filename === "epoch.json" || filename === "server-id")
        await cp(path.join(home, filename), path.join(destination, filename));
    }
    const entry = path.join(home, "runtime/malleaf-entry.json");
    await cp(entry, path.join(destination, "malleaf-entry.json")).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
let completed = false;
let failure;
try {
  await record("baseline", await controller.recover());
  const agent = await current.runtime.client.createAgent({
    provider: "mock",
    model: "ten-second-stream",
    cwd: prepared.root,
  });
  await current.runtime.client.sendMessage(agent.id, "Finish this accepted turn before switching.");
  const turnDeadline = Date.now() + 20_000;
  for (;;) {
    const status = await current.runtime.client.quiesceDaemon({
      action: "status",
      deadlineMs: 1000,
    });
    if (status.running.includes(agent.id)) {
      stages.push({ label: "active-before-switch", status });
      break;
    }
    assert.ok(Date.now() < turnDeadline, "mock turn did not start before the deadline");
    await delay(25);
  }
  const forward = request({ buildId: nextSlot.manifest.buildId, dataId: "candidate" });
  await record("trial", await controller.activate(forward));
  assert.equal(current.transaction.step, "trial");
  assert.equal(await note(baseline), "original epoch bytes\n");
  await record("kept", await controller.keep(forward.switchId));
  assert.deepEqual(current.pointer.previous, baseline);
  await record("keep-repeated", await controller.keep(forward.switchId));
  await writeFile(
    path.join(prepared.home, "data/candidate/retained-note.txt"),
    "new current bytes\n",
  );

  const back = request({ buildId: baseline.buildId, dataId: "previous-trial" }, baseline);
  await record("previous-cloned-trial", await controller.activate(back));
  assert.equal(await note(back.candidate), "original epoch bytes\n");
  await record("reverted-to-actual-baseline", await controller.revert(back.switchId));
  assert.deepEqual(current.pointer.current, forward.candidate);
  assert.equal(await note(forward.candidate), "new current bytes\n");

  for (const dataId of ["startup-fail", "probe-fail"]) {
    const fault = request({ buildId: faultSlot.manifest.buildId, dataId });
    await record(dataId, await controller.activate(fault));
    assert.equal(current.transaction.step, "rolled_back");
    assert.deepEqual(current.pointer.current, forward.candidate);
  }

  const interrupted = request({ buildId: baseSlot.manifest.buildId, dataId: "interrupted" });
  await journal.begin({ ...interrupted, baseline: current.pointer.current }, current.pointer);
  for (const step of ["preflight", "preflight_ok", "draining"])
    await journal.advance(interrupted.switchId, step);
  await current.runtime.client.quiesceDaemon({
    action: "begin",
    drainId: interrupted.drainId,
    deadlineMs: 10_000,
  });
  await current.runtime.client.quiesceDaemon({ action: "commit", drainId: interrupted.drainId });
  const frozenPid = current.runtime.instance.pid;
  await record("recovered-after-stop-commit", await reopen());
  assert.equal(current.transaction.step, "aborted");
  assert.notEqual(current.runtime.instance.pid, frozenPid);
  assert.equal(stages.at(-1).status.state, "accepting");

  const deadTrial = request({ buildId: baseSlot.manifest.buildId, dataId: "dead-trial" });
  await record("trial-before-interrupted-keep", await controller.activate(deadTrial));
  await journal.advance(deadTrial.switchId, "committing");
  // Intentional failure injection: stop only this exact owned, idle test instance.
  await current.runtime.stop();
  await record("dead-trial-after-keep-intent", await reopen());
  assert.equal(current.transaction.step, "rolled_back");
  assert.deepEqual(current.pointer.current, forward.candidate);

  for (const manifest of manifests)
    await verifySlot({
      directory: path.join(versionsRoot, manifest.buildId),
      expectedBuildId: manifest.buildId,
      mode: "full",
    });
  completed = true;
} catch (error) {
  failure = error;
}
async function cleanup() {
  await controller.disconnect();
  // Only acquired ledger instances are eligible for final test cleanup.
  const registered = Object.entries((await ledger.read()).registrations);
  for (const [role, registration] of registered) {
    if (!registration.instance)
      throw new Error(`Unresolved ${role} intent retained at ${prepared.root}`);
    pids.add(registration.instance.pid);
    await stopRuntimeInstance({
      daemonHome: registration.home,
      clientId: randomUUID(),
      instance: registration.instance,
      assertOwned: lease.assertOwned,
    });
    assert.equal(await readDaemonInstance(registration.home), null);
    await ledger.clear(role, registration.token);
  }
  await capture();
  await lease.release({
    seal: async () => {
      await pointer.seal();
      await journal.seal();
      await ledger.seal();
    },
  });
}
try {
  await cleanup();
} catch (cleanupError) {
  failure = failure
    ? new AggregateError([failure, cleanupError], "Switch acceptance and cleanup failed", {
        cause: cleanupError,
      })
    : cleanupError;
}
if (failure) throw failure;

for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
async function makeRemovable(directory) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory() && !entry.isSymbolicLink())
      await makeRemovable(path.join(directory, entry.name));
}
await makeRemovable(prepared.root);
await prepared.dispose();
const evidence = {
  sourceCommit: source.provenance.sourceCommit,
  evidenceRoot,
  completed,
  disposed: true,
  allObservedSupervisorsExited: true,
  slotUnchanged: true,
  pids: [...pids],
  stages,
};
await writeFile(path.join(evidenceRoot, "result.json"), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
