import { setTimeout as delay } from "node:timers/promises";
import type { MalleafQuiesceStatus } from "@getpaseo/protocol/malleaf/quiesce";
import { StorageError } from "../storage.js";
import type { RuntimeHandle } from "./daemon.js";

export function hasPendingDrainWork(status: MalleafQuiesceStatus): boolean {
  return Boolean(
    status.running.length ||
    status.pendingPermissions.length ||
    status.pendingRegistrations ||
    status.pendingAdmissions ||
    status.pendingDeliveries ||
    status.pendingScheduleRuns,
  );
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

export async function drainAndCommit(options: {
  runtime: RuntimeHandle;
  drainId: string;
  deadlineMs: number;
  assertOwned(): void;
}): Promise<boolean> {
  const { runtime, drainId, deadlineMs, assertOwned } = options;
  if (!runtime.client.supportsMalleafQuiesceCommit())
    throw new StorageError(
      "unsupported_schema",
      "Runtime lacks atomic drain commit; update it before switching",
    );
  const deadline = Date.now() + deadlineMs;
  assertOwned();
  try {
    await runtime.quiesce({ action: "begin", drainId, deadlineMs });
    while (Date.now() < deadline) {
      assertOwned();
      const status = await runtime.quiesce({ action: "status", deadlineMs: 1000 });
      if (status.state !== "draining" || status.drainId !== drainId) return false;
      // Resource status is advisory, not an atomic barrier. Pause without stopping.
      if (status.terminals || status.scripts) break;
      if (!hasPendingDrainWork(status)) {
        assertOwned();
        if (await tryCommit(runtime, drainId)) return true;
      }
      await delay(Math.min(50, Math.max(0, deadline - Date.now())));
    }
  } catch (error) {
    if (!["drain_timeout", "drain_not_active"].includes(String(errorCode(error)))) throw error;
  }
  // No stop signal is sent on timeout. If our lease is still held, release it.
  assertOwned();
  const status = await runtime.quiesce({ action: "status", deadlineMs: 1000 });
  if (status.state === "draining" && status.drainId === drainId)
    await runtime.quiesce({ action: "end", drainId, deadlineMs: 1000 });
  return false;
}

async function tryCommit(runtime: RuntimeHandle, drainId: string): Promise<boolean> {
  try {
    await runtime.quiesce({ action: "commit", drainId, deadlineMs: 1000 });
    return true;
  } catch (error) {
    if (errorCode(error) !== "drain_busy") throw error;
    return false;
  }
}
