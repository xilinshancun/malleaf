import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { isWithin, StorageError } from "./storage.js";
import { verifySlot } from "./slot/materialize.js";
import { readRunnerConfiguration } from "./runner/initialize.js";
import { acquireControlLease } from "./runner/lease.js";
import { openPointerStore } from "./runner/pointer.js";
import { openSwitchJournal } from "./runner/journal.js";
import { openInstanceLedger } from "./runner/instances.js";
import { createIsolatedActivation } from "./runtime/activation.js";
import { acceptanceBootEnvironment } from "./runtime/boot-environment.js";
import { assertAcceptanceBoundary } from "./isolation.js";

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
  const buildId = path.basename(slotDirectory);
  await verifySlot({ directory: slotDirectory, expectedBuildId: buildId, mode: "entries" });
  return { home, root, fakeHome, buildId, controlPort: values["control-port"] };
}

async function main() {
  const { home, root, fakeHome, buildId, controlPort } = await bootOptions();
  // Import/argument failures can fall back; no lease or state mutation occurs
  // until the parent has chosen the no-fallback side of its IPC boundary.
  if (!(await awaitAdmission(buildId)) || stopping) return;
  const config = await readRunnerConfiguration(home);
  if (String(config.controlPort) !== controlPort)
    throw new StorageError(
      "state_conflict",
      "Stable runner control port does not match persisted configuration",
    );
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
    const recovered = await activation.recover();
    process.stdout.write(
      `${JSON.stringify({ type: "malleaf.controller.ready", pid: process.pid, buildId, current: recovered.pointer.current, trial: recovered.pointer.trial, step: recovered.transaction?.step ?? null })}\n`,
    );
    await stopRequested;
  } finally {
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
