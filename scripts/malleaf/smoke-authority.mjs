import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { drainAndCommit } from "../../packages/malleaf-controller/dist/runtime/drain.js";
import { readDaemonInstance } from "../../packages/server/dist/server/server/daemon-instance.js";

export async function readAuthorityEvidence(registration, runtime) {
  assert.equal(runtime.info.malleaf.controllerOwned, true);
  assert.equal(runtime.client.supportsMalleafControllerAuthority(), true);
  const filename = path.join(registration.home, "runtime/controller-authority.json");
  const stat = await lstat(filename);
  assert.ok(stat.isFile());
  if (process.platform !== "win32") assert.equal(stat.mode & 0o777, 0o600);
  const contents = await readFile(filename, "utf8");
  const marker = JSON.parse(contents);
  assert.deepEqual(marker, {
    schemaVersion: 1,
    tokenHash: createHash("sha256").update(registration.controllerToken).digest("hex"),
  });
  assert.ok(!contents.includes(registration.controllerToken));
  return {
    pid: runtime.instance.pid,
    home: registration.home,
    controllerOwned: true,
    malleafControllerAuthority: true,
    marker,
    mode: stat.mode & 0o777,
  };
}

export async function exerciseAuthority(runtime, registration) {
  const rejected = [];
  const drainId = randomUUID();
  for (const [label, controllerToken] of [
    ["missing", undefined],
    ["invalid", "0".repeat(64)],
  ]) {
    assert.ok(controllerToken !== registration.controllerToken);
    for (const action of ["begin", "end", "commit"]) {
      await assert.rejects(
        runtime.client.quiesceDaemon({ action, drainId, deadlineMs: 1000, controllerToken }),
        /controller_owned/,
      );
      rejected.push(`${action}:${label}`);
    }
    await assert.rejects(
      runtime.client.shutdownServer({ timeout: 1000, controllerToken }),
      /controller_owned/,
    );
    rejected.push(`shutdown:${label}`);
  }
  const operations = [
    ["restart", () => runtime.client.restartServer()],
    ["update", () => runtime.client.updateDaemon()],
    ["reload", () => runtime.client.reloadDaemonConfig()],
    ["pairing", () => runtime.client.getDaemonPairingOffer({ timeout: 1000 })],
    ["config", () => runtime.client.patchDaemonConfig({ relay: { enabled: false } })],
    // Loopback port 1 is deliberately unusable, even if the rejection regresses.
    ["hub-connect", () => runtime.client.connectHub("http://127.0.0.1:1", "acceptance-fixture")],
    ["hub-permissions", () => runtime.client.updateHubPermissions({ grant: ["daemon.manage"] })],
  ];
  for (const [label, operation] of operations) {
    await assert.rejects(operation(), /controller_owned/);
    rejected.push(label);
  }
  await runtime.quiesce({ action: "begin", drainId, deadlineMs: 10_000 });
  const authorized = await runtime.quiesce({ action: "status", deadlineMs: 1000 });
  assert.equal(authorized.drainId, drainId);
  assert.equal(typeof authorized.expiresAt, "number");
  const publicStatuses = [];
  for (const controllerToken of [undefined, "0".repeat(64)]) {
    const status = await runtime.client.quiesceDaemon({
      action: "status",
      deadlineMs: 1000,
      controllerToken,
    });
    assert.equal(status.state, "draining");
    assert.equal(status.drainId, null);
    assert.equal(status.expiresAt, null);
    publicStatuses.push(status);
  }
  await runtime.quiesce({ action: "end", drainId });
  return { rejected, authorized, publicStatuses };
}

export async function exerciseResourcePause(runtime, registration, root, assertOwned) {
  const workspace = path.join(root, "authority-workspace");
  await mkdir(workspace);
  const filename = path.join(workspace, "terminal-authority-environment.json");
  const opened = await runtime.client.openProject(workspace);
  assert.ok(opened.workspace, opened.error ?? "Acceptance workspace was not created");
  const created = await runtime.client.createTerminal(
    workspace,
    "authority-acceptance",
    undefined,
    {
      workspaceId: opened.workspace.id,
      command: process.execPath,
      args: [
        "-e",
        `require("node:fs").writeFileSync(process.argv[1], JSON.stringify({
      controllerTokenPresent: process.env.MALLEAF_CONTROLLER_TOKEN !== undefined,
      authorityHashPresent: process.env.MALLEAF_CONTROLLER_AUTHORITY_HASH !== undefined
    })); setInterval(() => {}, 1000);`,
        filename,
      ],
    },
  );
  assert.equal(created.error, null);
  assert.ok(created.terminal);
  const snapshots = [];
  try {
    const deadline = Date.now() + 10_000;
    let environment;
    while (!environment) {
      environment = await readFile(filename, "utf8")
        .then(JSON.parse)
        .catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      assert.ok(Date.now() < deadline, "terminal did not publish its environment observation");
      if (!environment) await delay(25);
    }
    assert.deepEqual(environment, { controllerTokenPresent: false, authorityHashPresent: false });
    const committed = await drainAndCommit({
      runtime: {
        ...runtime,
        async quiesce(request) {
          const status = await runtime.quiesce(request);
          snapshots.push({ action: request.action, status });
          return status;
        },
      },
      drainId: randomUUID(),
      deadlineMs: 30_000,
      assertOwned,
    });
    assert.equal(committed, false);
    assert.ok(snapshots.some(({ status }) => status.state === "draining" && status.terminals > 0));
    assert.equal(snapshots.at(-1).action, "end");
    assert.equal(snapshots.at(-1).status.state, "accepting");
    const live = await readDaemonInstance(registration.home);
    assert.equal(live?.pid, runtime.instance.pid);
    assert.equal(live?.startedAt, runtime.instance.startedAt);
    return { environment, snapshots, pausedWithoutStopping: true };
  } finally {
    await runtime.client.killTerminal(created.terminal.id);
    const deadline = Date.now() + 10_000;
    while ((await runtime.quiesce({ action: "status" })).terminals) {
      assert.ok(Date.now() < deadline, "terminal remained after explicit close");
      await delay(25);
    }
  }
}

export async function exerciseFrozenShutdown(runtime, registration, assertOwned) {
  const drainId = randomUUID();
  await runtime.quiesce({ action: "begin", drainId, deadlineMs: 10_000 });
  const frozen = await runtime.quiesce({ action: "commit", drainId });
  assert.equal(frozen.state, "shutdown");
  for (const controllerToken of [undefined, "0".repeat(64)])
    await assert.rejects(
      runtime.client.shutdownServer({ timeout: 1000, controllerToken }),
      /controller_owned/,
    );
  assertOwned();
  const live = await readDaemonInstance(registration.home);
  assert.equal(live?.pid, registration.instance.pid);
  assert.equal(live?.startedAt, registration.instance.startedAt);
  const reply = await runtime.client.shutdownServer({
    timeout: 5000,
    controllerToken: registration.controllerToken,
  });
  const deadline = Date.now() + 15_000;
  for (;;) {
    const instance = await readDaemonInstance(registration.home);
    let exited = false;
    try {
      process.kill(registration.instance.pid, 0);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      exited = true;
    }
    if (!instance && exited) break;
    assert.ok(Date.now() < deadline, "authorized shutdown did not stop the exact instance");
    await delay(25);
  }
  return { instance: registration.instance, frozen, reply, stopped: true };
}
