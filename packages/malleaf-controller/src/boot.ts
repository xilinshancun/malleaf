import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { isWithin, StorageError } from "./storage.js";
import { verifySlot } from "./slot/materialize.js";
import { readRunnerConfiguration } from "./runner/initialize.js";
import { acquireControlLease } from "./runner/lease.js";
import { inspectPointer, openPointerStore } from "./runner/pointer.js";
import { openSwitchJournal } from "./runner/journal.js";
import { openInstanceLedger } from "./runner/instances.js";
import { createIsolatedActivation } from "./runtime/activation.js";
import { acceptanceBootEnvironment } from "./runtime/boot-environment.js";
import { assertAcceptanceBoundary } from "./isolation.js";
import { createAcceptanceSession, acceptanceStatus } from "./runner/acceptance-session.js";

let stopping = false;
let resolveStop!: () => void;
const stopRequested = new Promise<void>((resolve) => {
  resolveStop = resolve;
});
const requestStop = () => {
  stopping = true;
  resolveStop();
};
process.on("SIGTERM", requestStop);
process.on("SIGINT", requestStop);
process.on("message", (message: unknown) => {
  if (
    message &&
    typeof message === "object" &&
    "type" in message &&
    message.type === "malleaf.controller.stop"
  )
    requestStop();
});

async function awaitAdmission(buildId: string): Promise<boolean> {
  if (!process.send)
    throw new StorageError(
      "state_conflict",
      "Controller boot requires its stable runner IPC parent",
    );
  let onMessage: (message: unknown) => void;
  let onDisconnect: () => void;
  let timer: ReturnType<typeof setTimeout>;
  const acknowledged = new Promise<boolean>((resolve, reject) => {
    onMessage = (message) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "malleaf.controller.reject"
      ) {
        reject(
          new StorageError("identity_conflict", "Stable runner rejected controller load identity"),
        );
        return;
      }
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "malleaf.controller.proceed"
      )
        resolve(true);
    };
    onDisconnect = () => resolve(false);
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
    timer = setTimeout(() => reject(new Error("Stable runner acknowledgement timed out")), 10_000);
    process.send!(
      { type: "malleaf.controller.loaded", version: 1, buildId },
      (error: Error | null) => {
        if (error) reject(error);
      },
    );
  });
  try {
    return await Promise.race([acknowledged, stopRequested.then(() => false)]);
  } finally {
    clearTimeout(timer!);
    process.off("message", onMessage!);
    process.off("disconnect", onDisconnect!);
  }
}

async function bootOptions() {
  const { values } = parseArgs({
    options: {
      home: { type: "string" },
      "acceptance-root": { type: "string" },
      "control-port": { type: "string" },
      verify: { type: "boolean" },
      "boot-reason": { type: "string", default: "cold" },
    },
  });
  if (
    !values.home ||
    !values["acceptance-root"] ||
    !process.env.HOME ||
    process.env.MALLEAF_TEST !== "1"
  )
    throw new StorageError(
      "unsafe_path",
      "Controller boot is only available with an explicit isolated acceptance root",
    );
  const home = await realpath(values.home);
  const root = await realpath(values["acceptance-root"]);
  assertAcceptanceBoundary(root, home);
  const temporary = await realpath(os.tmpdir());
  const fakeHome = await realpath(process.env.HOME ?? "");
  if (
    root === temporary ||
    !isWithin(temporary, root) ||
    !isWithin(root, home) ||
    !isWithin(root, fakeHome)
  )
    throw new StorageError(
      "unsafe_path",
      "Controller boot requires temporary product and OS homes",
    );
  const slotDirectory = path.resolve(import.meta.dirname, "../../..");
  if (!["cold", "handoff"].includes(values["boot-reason"] ?? ""))
    throw new StorageError("invalid_state", "Unknown controller boot reason");
  const buildId = path.basename(slotDirectory);
  await verifySlot({ directory: slotDirectory, expectedBuildId: buildId, mode: "entries" });
  return {
    home,
    root,
    fakeHome,
    buildId,
    controlPort: values["control-port"],
    verify: values.verify === true,
    bootReason: values["boot-reason"],
  };
}

async function verifyBootState(home: string, controlPort: string | undefined) {
  const config = await readRunnerConfiguration(home);
  const pointer = await inspectPointer(home);
  if (String(config.controlPort) !== controlPort)
    throw new StorageError(
      "state_conflict",
      "Stable runner control port does not match persisted configuration",
    );
  if (config.minWriterVersion > 1 || pointer.minWriterVersion > 1)
    throw new StorageError("unsupported_schema", "Controller cannot write this runtime state");
  return config;
}

function sendVerification(buildId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send || !process.connected) {
      reject(new Error("Controller self-check requires IPC"));
      return;
    }
    process.send({ type: "malleaf.controller.verified", buildId }, (error: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sendIpc(message: object): Promise<boolean> {
  return new Promise((resolve) => {
    if (!process.send || !process.connected) {
      resolve(false);
      return;
    }
    try {
      process.send(message, (error: Error | null) => resolve(!error));
    } catch {
      resolve(false);
    }
  });
}

async function main() {
  const { home, root, fakeHome, buildId, controlPort, verify, bootReason } = await bootOptions();
  if (verify) {
    await verifyBootState(home, controlPort);
    await sendVerification(buildId);
    return;
  }
  // Import/argument failures can fall back; no lease or state mutation occurs
  // until the parent has chosen the no-fallback side of its IPC boundary.
  if (!(await awaitAdmission(buildId)) || stopping) return;
  const config = await verifyBootState(home, controlPort);
  const lease = await acquireControlLease({
    home,
    port: config.controlPort,
    buildId,
    role: "controller",
  });
  let pointer: Awaited<ReturnType<typeof openPointerStore>> | undefined;
  let journal: Awaited<ReturnType<typeof openSwitchJournal>> | undefined;
  let ledger: Awaited<ReturnType<typeof openInstanceLedger>> | undefined;
  let activation: Awaited<ReturnType<typeof createIsolatedActivation>> | undefined;
  let acceptance: ReturnType<typeof createAcceptanceSession> | undefined;
  let commandListener: ((message: unknown) => void) | undefined;
  let cleanExitCode = 0;
  try {
    if (stopping) return;
    await lease.publishIdentity();
    pointer = await openPointerStore({
      home,
      assertOwned: lease.assertOwned,
      writerToken: randomUUID(),
    });
    journal = await openSwitchJournal({ home, assertOwned: lease.assertOwned });
    ledger = await openInstanceLedger({ home, assertOwned: lease.assertOwned });
    const temporary = path.join(root, "tmp");
    await mkdir(temporary, { recursive: true });
    const environment = acceptanceBootEnvironment({ root, home, fakeHome, inherited: process.env });
    activation = await createIsolatedActivation({
      acceptanceRoot: root,
      home,
      environment,
      pointer,
      journal,
      ledger,
      assertOwned: lease.assertOwned,
      shared: {
        plugins: path.join(home, "plugins"),
        worktrees: path.join(home, "worktrees"),
        models: path.join(home, "models"),
      },
      policy: { schemaVersion: 1, entries: {} },
    });
    const active = activation;
    const ownedPointer = pointer;
    const ownedJournal = journal;
    let current: Awaited<ReturnType<typeof active.recover>> & { paused?: boolean } =
      await active.recover({ attachOnly: bootReason === "handoff" });
    acceptance = createAcceptanceSession({
      buildId,
      send: sendIpc,
      isStopping: () => stopping,
      onHandoff: () => {
        cleanExitCode = 75;
        requestStop();
      },
      execute: async (request) => {
        switch (request.command) {
          case "activate":
            current = await active.activate(request.params);
            break;
          case "keep":
            current = await active.keep(request.params.switchId);
            break;
          case "revert":
            current = await active.revert(request.params.switchId);
            break;
          case "status":
            current = {
              ...current,
              pointer: await ownedPointer.read(),
              transaction: (await ownedJournal.read()).transaction,
            };
            break;
        }
        return {
          pointer: current.pointer,
          transaction: current.transaction,
          instance: current.runtime?.instance ?? null,
          runtimeIdentity: current.runtime?.info.malleaf ?? null,
          ...(await acceptanceStatus(
            () =>
              current.runtime?.client.quiesceDaemon({ action: "status", deadlineMs: 1000 }) ??
              Promise.resolve(null),
          )),
          paused: current.paused ?? false,
        };
      },
    });
    const session = acceptance;
    commandListener = (message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "malleaf.controller.request"
      )
        void session
          .handle(message)
          .catch((error) =>
            process.stderr.write(`Acceptance command delivery failed: ${String(error)}\n`),
          );
    };
    process.on("message", commandListener);
    const ready = {
      type: "malleaf.controller.ready",
      pid: process.pid,
      buildId,
      current: current.pointer.current,
      trial: current.pointer.trial,
      step: current.transaction?.step ?? null,
    };
    await sendIpc(ready);
    process.stdout.write(`${JSON.stringify(ready)}\n`);
    await stopRequested;
  } finally {
    if (commandListener) process.off("message", commandListener);
    await acceptance?.settle();
    // A controller restart leaves the exact registered daemon detached and alive.
    try {
      await activation?.disconnect();
    } finally {
      await lease.release({
        seal: async () => {
          await pointer?.seal();
          await journal?.seal();
          await ledger?.seal();
        },
      });
    }
  }
  process.exitCode = cleanExitCode;
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    if (error instanceof StorageError) {
      const codes: Partial<Record<StorageError["code"], number>> = {
        lease_held: 72,
        port_occupied: 73,
        unsupported_schema: 65,
        invalid_state: 65,
        state_conflict: 78,
        unsafe_path: 78,
      };
      process.exitCode = codes[error.code] ?? 70;
    } else process.exitCode = 70;
  })
  .finally(() => {
    if (process.connected) process.disconnect();
  });
