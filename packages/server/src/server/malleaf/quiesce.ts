import {
  DaemonQuiesceRequestSchema,
  MalleafDrainIdSchema,
  type MalleafQuiesceStatus,
} from "@getpaseo/protocol/malleaf/quiesce";
import type { AgentManager } from "../agent/agent-manager.js";

export interface QuiesceClock {
  now(): number;
  schedule(callback: () => void, ms: number): () => void;
}

export class QuiesceError extends Error {
  constructor(
    readonly code:
      | "drain_active"
      | "drain_not_owned"
      | "drain_not_active"
      | "drain_busy"
      | "drain_timeout"
      | "daemon_stopping",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "QuiesceError";
  }
}

const systemClock: QuiesceClock = {
  now: Date.now,
  schedule(callback, ms) {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export function createQuiesceController(options: {
  agentManager: Pick<
    AgentManager,
    "beginDrain" | "endDrain" | "isDraining" | "getDrainWork" | "prepareForShutdown"
  >;
  schedules: {
    pauseForDrain(): void;
    stop(options?: { drainTimeoutMs?: number }): Promise<void>;
    resumeAfterDrain(): void | Promise<void>;
    pendingRuns(): number;
  };
  releaseBootDrain?(drainId: string): Promise<void>;
  countResources(): Promise<{ terminals: number; scripts: number }>;
  pendingDeliveries(): number;
  onError(error: unknown): void;
  clock?: QuiesceClock;
}) {
  const clock = options.clock ?? systemClock;
  let lease: { drainId: string; expiresAt: number | null } | null = null;
  let cancelTimer: (() => void) | undefined;
  let shutdown = false;
  let scheduleError: string | null = null;
  let tail = Promise.resolve();

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function status(): Promise<MalleafQuiesceStatus> {
    const resources = await options.countResources();
    let state: MalleafQuiesceStatus["state"] = lease ? "draining" : "accepting";
    if (shutdown) state = "shutdown";
    return {
      state,
      drainId: lease?.drainId ?? null,
      expiresAt: lease?.expiresAt ?? null,
      ...options.agentManager.getDrainWork(),
      pendingDeliveries: options.pendingDeliveries(),
      pendingScheduleRuns: options.schedules.pendingRuns(),
      ...resources,
      scheduleError,
    };
  }

  function requireRunning() {
    if (shutdown) throw new QuiesceError("daemon_stopping", "Daemon shutdown has begun");
  }

  async function resumeSchedules() {
    try {
      await options.schedules.resumeAfterDrain();
      scheduleError = null;
    } catch (error) {
      scheduleError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (shutdown) await options.schedules.stop();
    }
  }

  function end(drainId: string, expiredLease?: typeof lease): Promise<MalleafQuiesceStatus> {
    return serialize(async () => {
      if (expiredLease && shutdown) return status();
      requireRunning();
      if (expiredLease && lease !== expiredLease) return status();
      if (!lease) return status();
      if (lease.drainId !== drainId)
        throw new QuiesceError("drain_not_owned", "A different runtime switch owns the drain");
      if (lease.expiresAt === null) {
        // The release must survive a supervisor-driven worker restart. Failure
        // leaves this gate closed; a successful write precedes all admission.
        if (!options.releaseBootDrain) throw new Error("Boot release storage is unavailable");
        await options.releaseBootDrain(drainId);
        if (shutdown) return status();
      }
      cancelTimer?.();
      cancelTimer = undefined;
      lease = null;
      options.agentManager.endDrain();
      // Never apply boot-time interrupted-run recovery to a live paused service.
      await resumeSchedules();
      return status();
    });
  }

  function commit(drainId: string): Promise<MalleafQuiesceStatus> {
    return serialize(async () => {
      requireRunning();
      if (!lease || lease.drainId !== drainId || !options.agentManager.isDraining())
        throw new QuiesceError("drain_not_active", "No matching active drain can be committed");
      if (lease.expiresAt !== null && clock.now() >= lease.expiresAt)
        throw new QuiesceError("drain_timeout", "Drain expired before stop could be committed");
      const work = options.agentManager.getDrainWork();
      if (
        work.running.length ||
        work.pendingPermissions.length ||
        work.pendingRegistrations ||
        work.pendingAdmissions ||
        options.pendingDeliveries() ||
        options.schedules.pendingRuns()
      )
        throw new QuiesceError("drain_busy", "Accepted work must finish before committing stop");
      // No await between the authoritative counters and the permanent admission
      // freeze. Async terminal/script counts are diagnostics, not this barrier.
      options.agentManager.prepareForShutdown();
      shutdown = true;
      cancelTimer?.();
      cancelTimer = undefined;
      return status();
    });
  }

  function begin(input: { drainId: string; deadlineMs: number }): Promise<MalleafQuiesceStatus> {
    DaemonQuiesceRequestSchema.parse({
      type: "daemon.quiesce.request",
      requestId: "internal",
      action: "begin",
      ...input,
    });
    const expiresAt = clock.now() + input.deadlineMs;
    return serialize(async () => {
      requireRunning();
      if (lease && lease.drainId !== input.drainId)
        throw new QuiesceError("drain_active", "Another runtime switch is draining this daemon");
      if (lease?.expiresAt === null) return status();
      if (clock.now() >= expiresAt)
        throw new QuiesceError(
          "drain_timeout",
          "Drain request expired while waiting; retry or cancel",
        );
      if (!lease) {
        try {
          // An accepted tick can create agents and wait for their entire turn. Let
          // it finish, including finishRun persistence, before closing admission.
          await options.schedules.stop({ drainTimeoutMs: expiresAt - clock.now() });
          requireRunning();
          if (clock.now() >= expiresAt)
            throw new QuiesceError(
              "drain_timeout",
              "Accepted schedules exceeded the drain deadline; retry or cancel",
            );
          options.agentManager.beginDrain();
        } catch (error) {
          // On timeout the active tick is still alive. Restore timers only; boot
          // recovery would mark that live run as interrupted and archive its work.
          if (!shutdown) await resumeSchedules().catch(options.onError);
          if (!shutdown && clock.now() >= expiresAt)
            throw new QuiesceError(
              "drain_timeout",
              "Accepted schedules exceeded the drain deadline; retry or cancel",
            );
          throw error;
        }
      }
      lease = { drainId: input.drainId, expiresAt };
      const expiringLease = lease;
      cancelTimer?.();
      cancelTimer = clock.schedule(
        () => {
          // A callback already queued before renewal must not release the renewed lease.
          if (shutdown || lease !== expiringLease) return;
          void end(input.drainId, expiringLease).catch(options.onError);
        },
        Math.max(0, expiresAt - clock.now()),
      );
      return status();
    });
  }

  function adoptBootDrain(drainId: string): void {
    requireRunning();
    MalleafDrainIdSchema.parse(drainId);
    if (!options.releaseBootDrain) throw new Error("Boot drain requires durable release storage");
    if (lease) throw new QuiesceError("drain_active", "Boot admission is already configured");
    options.schedules.pauseForDrain();
    options.agentManager.beginDrain();
    lease = { drainId, expiresAt: null };
  }

  return {
    adoptBootDrain,
    begin,
    commit,
    end: (drainId: string) => end(drainId),
    status,
    dispose() {
      shutdown = true;
      options.agentManager.beginDrain();
      cancelTimer?.();
      cancelTimer = undefined;
      return tail;
    },
  };
}
export type QuiesceController = ReturnType<typeof createQuiesceController>;
