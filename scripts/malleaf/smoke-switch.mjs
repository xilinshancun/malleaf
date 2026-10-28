#!/usr/bin/env node
import { evidenceJson, copyRunnerEvidence, assertNoControllerTokens } from "./smoke-audit.mjs";
// Journalled activation acceptance in a new mock-only temporary product home.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { preparePreflight } from "../../packages/malleaf-controller/dist/runtime/preflight.js";
import { createIsolatedActivation } from "../../packages/malleaf-controller/dist/runtime/activation.js";
import {
  attachRuntime,
  stopRuntimeInstance,
} from "../../packages/malleaf-controller/dist/runtime/daemon.js";
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
import { bindControllerBuild, captureHostState, assertNoSlotProcesses } from "./smoke-audit.mjs";
import { readDaemonInstance } from "../../packages/server/dist/server/server/daemon-instance.js";

if (!process.argv[2])
  throw new Error("Usage: node scripts/malleaf/smoke-switch.mjs <verified-physical-slot>");
const sourceSlot = path.resolve(process.argv[2]);
const source = await verifySlot({
  directory: sourceSlot,
  expectedBuildId: path.basename(sourceSlot),
  mode: "full",
});
const binding = await bindControllerBuild(source);
const hostBefore = await captureHostState();
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
    provenance: {
      ...source.provenance,
      builder: sourceRoot === sourceSlot ? source.provenance.builder : "smoke-switch-fault-fixture",
      display,
      createdAt: new Date().toISOString(),
    },
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
const reportedShutdown = /if \(shutdown\)(?=\s+state = "shutdown";)/g;
assert.equal([...quiesceSource.matchAll(reportedShutdown)].length, 1);
await chmod(quiesce, 0o600);
await writeFile(
  quiesce,
  quiesceSource.replace(
    reportedShutdown,
    'if (shutdown || process.env.MALLEAF_DAEMON_HOME?.endsWith("probe-fail"))',
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
// Capture identities from our own onAcquired callback even if the subsequent
// ledger write fails. Cleanup never uses a command-line/process-list match.
const pids = new Set();
const launches = new Map();
const acquired = new Map();
const knownByHome = new Map();
const bootSnapshots = [];
const originalIntent = ledger.intent;
ledger.intent = async (role, input) => {
  if (role === "candidate")
    await assert.rejects(readFile(path.join(input.home, "runtime/controller-authority.json")), {
      code: "ENOENT",
    });
  const result = await originalIntent(role, input);
  launches.set(input.token, {
    role,
    ...input,
    authorityMarkerAbsentBeforeLaunch: role === "candidate",
  });
  return result;
};
const originalAcquired = ledger.acquired;
ledger.acquired = async (role, token, instance) => {
  const intent = launches.get(token);
  assert.ok(intent, "acquisition must belong to this smoke's launch intent");
  const acquisition = { ...intent, instance };
  pids.add(instance.pid);
  acquired.set(instance.pid, acquisition);
  knownByHome.set(intent.home, acquisition);
  const result = await originalAcquired(role, token, instance);
  if (
    role === "candidate" &&
    instance.listen &&
    !bootSnapshots.some((snapshot) => snapshot.pid === instance.pid)
  ) {
    const observer = await attachRuntime({
      slotDirectory: path.join(versionsRoot, intent.buildId),
      buildId: intent.buildId,
      daemonHome: intent.home,
      controllerToken: intent.controllerToken,
      expected: instance,
      clientId: randomUUID(),
      assertOwned: lease.assertOwned,
    });
    try {
      const status = await observer.quiesce({ action: "status", deadlineMs: 1000 });
      await assert.rejects(readFile(path.join(intent.home, "runtime/boot-drain-released.json")), {
        code: "ENOENT",
      });
      assert.equal(
        (await pointer.read()).trial,
        null,
        "gate must be observed before trial publication",
      );
      const snapshot = {
        pid: instance.pid,
        dataId: path.basename(intent.home),
        bootDrainId: intent.bootDrainId,
        at: new Date().toISOString(),
        status,
        markerAbsentBeforeTrial: true,
      };
      bootSnapshots.push(snapshot);
      if (snapshot.dataId !== "probe-fail") {
        assert.equal(status.state, "draining");
        assert.equal(status.drainId, intent.bootDrainId);
        assert.equal(status.expiresAt, null);
      }
    } finally {
      await observer.client.close();
    }
  }
  return result;
};
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
      ? await result.runtime.quiesce({ action: "status", deadlineMs: 1000 })
      : null,
  };
  const acquiredEntry = result.runtime && acquired.get(result.runtime.instance.pid);
  if (acquiredEntry?.bootDrainId && snapshot.status?.state === "accepting") {
    snapshot.bootRelease = JSON.parse(
      await readFile(path.join(acquiredEntry.home, "runtime/boot-drain-released.json"), "utf8"),
    );
    assert.equal(snapshot.bootRelease.drainId, acquiredEntry.bootDrainId);
  }
  stages.push(snapshot);
  await writeFile(path.join(evidenceRoot, "stages.json"), evidenceJson(stages, null, 2));
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
  await writeFile(path.join(evidenceRoot, "manifests.json"), evidenceJson(manifests, null, 2));
  await copyRunnerEvidence(prepared.home, path.join(evidenceRoot, "runner"));
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
async function assertAuthority(runtime) {
  assert.equal(runtime.info.malleaf.controllerOwned, true);
  assert.equal(runtime.client.supportsMalleafControllerAuthority(), true);
  const drainId = randomUUID();
  for (const action of ["begin", "end", "commit"]) {
    await assert.rejects(
      runtime.client.quiesceDaemon({ action, drainId, deadlineMs: 1000 }),
      /controller_owned/,
    );
  }
  await assert.rejects(runtime.client.shutdownServer({ timeout: 1000 }), /controller_owned/);
  await assert.rejects(runtime.client.restartServer(), /controller_owned/);
  await assert.rejects(
    runtime.client.patchDaemonConfig({ relay: { enabled: true } }),
    /controller_owned/,
  );
  await runtime.quiesce({ action: "begin", drainId, deadlineMs: 10_000 });
  const publicStatus = await runtime.client.quiesceDaemon({ action: "status", deadlineMs: 1000 });
  assert.equal(publicStatus.drainId, null);
  assert.equal(publicStatus.expiresAt, null);
  assert.equal((await runtime.quiesce({ action: "status", deadlineMs: 1000 })).drainId, drainId);
  await runtime.quiesce({ action: "end", drainId });
}
let completed = false;
let failure;
try {
  await record("baseline", await controller.recover());
  await assertAuthority(current.runtime);
  const agent = await current.runtime.client.createAgent({
    provider: "mock",
    model: "ten-second-stream",
    cwd: prepared.root,
  });
  await current.runtime.client.sendMessage(agent.id, "Finish this accepted turn before switching.");
  const turnDeadline = Date.now() + 20_000;
  for (;;) {
    const status = await current.runtime.quiesce({
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
  const baselineClient = current.runtime.client;
  const observation = { active: true };
  let observedActiveDrain = false;
  const observer = (async () => {
    while (observation.active) {
      const status = await baselineClient.quiesceDaemon({ action: "status", deadlineMs: 1000 });
      if (status.state === "draining" && status.running.includes(agent.id)) {
        observedActiveDrain = true;
        stages.push({ label: "active-during-drain", at: new Date().toISOString(), status });
        return;
      }
      await delay(20);
    }
  })();
  // Attach a rejection handler immediately; await the original promise below so
  // an observer failure remains a failed acceptance, never an unhandled reject.
  void observer.catch(() => {});
  try {
    await record("trial", await controller.activate(forward));
  } finally {
    observation.active = false;
    await observer;
  }
  assert.ok(observedActiveDrain, "drain must be observed while the accepted turn is running");
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
    assert.match(
      current.transaction.error,
      dataId === "startup-fail" ? /cleanup verified.*exit 42/s : /not quiescent/,
    );
    assert.equal((await ledger.read()).registrations.candidate, undefined);
    if (dataId === "probe-fail") {
      const failed = [...acquired.values()].filter(
        (entry) => path.basename(entry.home) === "probe-fail",
      );
      assert.equal(failed.length, 1, "probe fault must acquire its own candidate instance");
      assert.throws(() => process.kill(failed[0].instance.pid, 0), { code: "ESRCH" });
    }
  }

  const interrupted = request({ buildId: baseSlot.manifest.buildId, dataId: "interrupted" });
  await journal.begin({ ...interrupted, baseline: current.pointer.current }, current.pointer);
  for (const step of ["preflight", "preflight_ok", "draining"])
    await journal.advance(interrupted.switchId, step);
  await current.runtime.quiesce({
    action: "begin",
    drainId: interrupted.drainId,
    deadlineMs: 10_000,
  });
  await current.runtime.quiesce({ action: "commit", drainId: interrupted.drainId });
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
  await verifySlot({ directory: sourceSlot, expectedBuildId: source.buildId, mode: "full" });
  completed = true;
} catch (error) {
  failure = error;
}
async function cleanup() {
  const errors = [];
  await controller.disconnect().catch((error) => errors.push(error));
  // Stop all exact acquired instances before reporting unresolved intents. The
  // memory records survive a poisoned writer and were obtained before its write.
  for (const registration of knownByHome.values()) {
    try {
      await stopRuntimeInstance({
        daemonHome: registration.home,
        controllerToken: registration.controllerToken,
        clientId: randomUUID(),
        instance: registration.instance,
        assertOwned: lease.assertOwned,
      });
      assert.equal(await readDaemonInstance(registration.home), null);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    for (const [role, registration] of Object.entries((await ledger.read()).registrations)) {
      if (!registration.instance) {
        errors.push(new Error(`Unresolved ${role} intent retained at ${prepared.root}`));
        continue;
      }
      assert.equal(await readDaemonInstance(registration.home), null);
      await ledger.clear(role, registration.token);
    }
  } catch (error) {
    errors.push(error);
  }
  await capture().catch((error) => errors.push(error));
  await lease
    .release({
      seal: async () => {
        await pointer.seal();
        await journal.seal();
        await ledger.seal();
      },
    })
    .catch((error) => errors.push(error));
  if (errors.length) throw new AggregateError(errors, "Acceptance cleanup was incomplete");
}
let hostAfter;
let remainingSlotProcesses;
try {
  await cleanup();
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  remainingSlotProcesses = await assertNoSlotProcesses(prepared.root);
  hostAfter = await captureHostState();
  assert.deepEqual(hostAfter, hostBefore, "Observed host instance/path metadata changed");
} catch (cleanupError) {
  failure = failure
    ? new AggregateError([failure, cleanupError], "Switch acceptance and cleanup failed", {
        cause: cleanupError,
      })
    : cleanupError;
}
if (failure) {
  await writeFile(
    path.join(evidenceRoot, "failure.json"),
    evidenceJson(
      {
        sourceCommit: source.provenance.sourceCommit,
        binding,
        root: prepared.root,
        error: String(failure),
        stack: failure.stack,
        causes: failure instanceof AggregateError ? failure.errors.map(String) : [],
        stages,
        acquired: [...acquired.values()],
        hostBefore,
        hostAfter,
      },
      null,
      2,
    ),
  );
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
const evidence = {
  sourceCommit: source.provenance.sourceCommit,
  binding,
  hostBefore,
  hostAfter,
  remainingSlotProcesses,
  acquired: [...acquired.values()],
  evidenceRoot,
  completed,
  disposed: true,
  allObservedSupervisorsExited: true,
  slotUnchanged: true,
  controllerAuthorityChecked: true,
  pids: [...pids],
  bootSnapshots,
  stages,
};
await writeFile(path.join(evidenceRoot, "result.json"), evidenceJson(evidence, null, 2));
await assertNoControllerTokens(
  evidenceRoot,
  [...launches.values()].map((launch) => launch.controllerToken),
);
evidence.controllerTokensRedacted = true;
await writeFile(path.join(evidenceRoot, "result.json"), evidenceJson(evidence, null, 2));
console.log(evidenceJson(evidence, null, 2));
