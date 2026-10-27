#!/usr/bin/env node
// A supplied physical slot is exercised only in a new disposable OS/product home.
// This is process acceptance, not activation of the installed personal runtime.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { preparePreflight } from "../../packages/malleaf-controller/dist/runtime/preflight.js";
import { launchRuntime } from "../../packages/malleaf-controller/dist/runtime/daemon.js";
import { acquireControlLease } from "../../packages/malleaf-controller/dist/runner/lease.js";
import { verifySlot } from "../../packages/malleaf-controller/dist/slot/materialize.js";

if (!process.argv[2]) throw new Error("Usage: node scripts/malleaf/smoke-slot.mjs <physical-slot>");
const directory = path.resolve(process.argv[2]);
const buildId = path.basename(directory);
const prepared = await preparePreflight({ slotDirectory: directory });
const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "malleaf-slot-evidence-"));
prepared.env.NODE_DEBUG = "esm,module";
prepared.env.NODE_V8_COVERAGE = path.join(prepared.root, "coverage");
process.stderr.write(`Preflight: ${prepared.root}\nEvidence: ${evidenceRoot}\n`);
const reservation = net.createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = reservation.address().port;
await promisify(reservation.close.bind(reservation))();
const lease = await acquireControlLease({ home: prepared.home, port, buildId, role: "controller" });
const processIds = new Set();
const logFiles = [];
async function captureEvidence(label) {
  const target = path.join(evidenceRoot, label);
  await mkdir(target);
  for (const filename of await readdir(prepared.daemonHome)) {
    if (!filename.endsWith(".log") && filename !== "daemon.log.txt") continue;
    await copyFile(path.join(prepared.daemonHome, filename), path.join(target, filename));
    logFiles.push(`${label}/${filename}`);
    const log = await readFile(path.join(target, filename), "utf8");
    for (const match of log.matchAll(/(?:ESM|MODULE) (\d+):/g)) processIds.add(Number(match[1]));
  }
  await copyFile(
    path.join(prepared.daemonHome, "runtime/malleaf-entry.json"),
    path.join(target, "malleaf-entry.json"),
  );
}
let runtime;
let evidence;
try {
  await lease.publishIdentity();
  runtime = await launchRuntime({
    slotDirectory: directory,
    buildId,
    daemonHome: prepared.daemonHome,
    environment: prepared.env,
    clientId: randomUUID(),
    assertOwned: lease.assertOwned,
    timeoutMs: 60_000,
  });
  const instance = runtime.instance;
  processIds.add(instance.pid);
  const info = runtime.info;
  const entryHashes = runtime.entryHashes;
  const packageInfo = JSON.parse(
    await readFile(path.join(directory, "packages/server/package.json"), "utf8"),
  );
  assert.equal(info.version, packageInfo.version);
  const initial = await runtime.client.quiesceDaemon({ action: "status", deadlineMs: 1000 });
  assert.equal(initial.state, "accepting");
  const drainId = randomUUID();
  const draining = await runtime.client.quiesceDaemon({
    action: "begin",
    drainId,
    deadlineMs: 10_000,
  });
  assert.equal(draining.state, "draining");
  for (const name of [
    "pendingRegistrations",
    "pendingAdmissions",
    "pendingDeliveries",
    "pendingScheduleRuns",
  ])
    assert.equal(draining[name], 0);
  assert.deepEqual(draining.running, []);
  assert.deepEqual(draining.pendingPermissions, []);
  assert.equal(
    (await runtime.client.quiesceDaemon({ action: "status", deadlineMs: 1000 })).drainId,
    drainId,
  );
  await assert.rejects(
    runtime.client.quiesceDaemon({ action: "end", drainId: randomUUID(), deadlineMs: 1000 }),
    /drain_not_owned/,
  );
  assert.equal(
    (await runtime.client.quiesceDaemon({ action: "end", drainId, deadlineMs: 1000 })).state,
    "accepting",
  );
  await runtime.stop();
  runtime = undefined;
  await assert.rejects(stat(path.join(prepared.daemonHome, "paseo.pid")), { code: "ENOENT" });
  await verifySlot({ directory, expectedBuildId: buildId, mode: "full" });
  await captureEvidence("normal");
  const abort = new AbortController();
  let abortedInstance;
  await assert.rejects(
    launchRuntime({
      slotDirectory: directory,
      buildId,
      daemonHome: prepared.daemonHome,
      environment: prepared.env,
      clientId: randomUUID(),
      assertOwned: lease.assertOwned,
      signal: abort.signal,
      recordInstance: async (acquired) => {
        abortedInstance = acquired;
        abort.abort(new Error("Injected startup abort after acquiring pid-lock"));
      },
    }),
    /abort/i,
  );
  assert.ok(abortedInstance);
  processIds.add(abortedInstance.pid);
  await assert.rejects(stat(path.join(prepared.daemonHome, "paseo.pid")), { code: "ENOENT" });
  assert.throws(() => process.kill(abortedInstance.pid, 0), { code: "ESRCH" });
  await captureEvidence("aborted");
  evidence = {
    buildId,
    serverId: info.serverId,
    version: info.version,
    instance,
    entryHashes,
    identity: info.malleaf,
    draining,
    preflightRoot: prepared.root,
    evidenceRoot,
    stopped: true,
    slotUnchanged: true,
    wrongDrainRejected: true,
    abortedInstance,
    abortCleaned: true,
  };
} finally {
  try {
    await runtime?.stop();
  } finally {
    // This probe has no pointer writer; all process operations above are awaited.
    await lease.release({ seal: async () => {} });
  }
}
// Keep logs outside the disposable runtime; a successful probe cleans all state.
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
const deadline = Date.now() + 5000;
while ([...processIds].some(isAlive) && Date.now() < deadline) await delay(25);
assert.deepEqual([...processIds].filter(isAlive), [], "Every observed probe process must exit");
const loadedFiles = {};
for (const filename of await readdir(prepared.env.NODE_V8_COVERAGE)) {
  const match = /^coverage-(\d+)-/.exec(filename);
  if (!match) continue;
  const coverage = JSON.parse(
    await readFile(path.join(prepared.env.NODE_V8_COVERAGE, filename), "utf8"),
  );
  const paths = coverage.result
    .map((entry) => entry.url)
    .filter((url) => url.startsWith("file://") || path.isAbsolute(url))
    .map((url) => (url.startsWith("file://") ? fileURLToPath(url) : url));
  for (const loadedPath of paths) {
    const relative = path.relative(directory, loadedPath);
    assert.ok(
      relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
      `Loaded file outside slot: ${loadedPath}`,
    );
  }
  loadedFiles[match[1]] = [...new Set([...(loadedFiles[match[1]] ?? []), ...paths])].sort();
}
assert.ok(
  loadedFiles[evidence.instance.pid]?.length,
  "Supervisor loaded-module evidence is required",
);
await writeFile(path.join(evidenceRoot, "loaded-files.json"), JSON.stringify(loadedFiles, null, 2));
await prepared.dispose();
await assert.rejects(stat(prepared.root), { code: "ENOENT" });
process.stdout.write(
  `${JSON.stringify({ ...evidence, logFiles, loadedFileCounts: Object.fromEntries(Object.entries(loadedFiles).map(([pid, files]) => [pid, files.length])), processIds: [...processIds], allObservedProcessesExited: true, disposed: true }, null, 2)}\n`,
);
