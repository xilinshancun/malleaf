import { expect, test } from "vitest";
import { createQuiesceController, type QuiesceClock } from "./quiesce.js";

class ManualClock implements QuiesceClock {
  time = 0;
  callbacks = new Set<() => void>();
  now = () => this.time;
  schedule = (callback: () => void, _ms: number) => {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  };
  expire() {
    for (const callback of this.callbacks) callback();
  }
}

function fixture(overrides: { start?: () => Promise<void>; stop?: () => Promise<void> } = {}) {
  const clock = new ManualClock();
  const calls: string[] = [];
  const errors: unknown[] = [];
  const controller = createQuiesceController({
    agentManager: {
      beginDrain: () => {
        calls.push("drain");
      },
      endDrain: () => {
        calls.push("accept");
      },
      getDrainWork: () => ({
        running: ["pending-turn"],
        pendingPermissions: [],
        pendingRegistrations: 1,
        pendingAdmissions: 0,
      }),
    },
    schedules: {
      stop: async () => {
        calls.push("pause schedules");
        await overrides.stop?.();
      },
      resumeAfterDrain: async () => {
        calls.push("resume schedules");
        await overrides.start?.();
      },
      pendingRuns: () => 0,
    },
    pendingDeliveries: () => 0,
    countResources: async () => ({ terminals: 2, scripts: 1 }),
    onError: (error) => {
      errors.push(error);
    },
    clock,
  });
  return { controller, clock, calls, errors };
}
const drainId = "00000000-0000-4000-8000-000000000001";
const anotherId = "00000000-0000-4000-8000-000000000002";

test("drain ownership survives retries and expiry resumes admission once", async () => {
  const { controller, clock, calls } = fixture();
  await expect(controller.begin({ drainId, deadlineMs: 1000 })).resolves.toEqual({
    state: "draining",
    drainId,
    expiresAt: 1000,
    running: ["pending-turn"],
    pendingPermissions: [],
    pendingRegistrations: 1,
    pendingAdmissions: 0,
    terminals: 2,
    scripts: 1,
    scheduleError: null,
    pendingDeliveries: 0,
    pendingScheduleRuns: 0,
  });
  await controller.begin({ drainId, deadlineMs: 2000 });
  await expect(controller.begin({ drainId: anotherId, deadlineMs: 1000 })).rejects.toThrow(
    "drain_active",
  );
  await expect(controller.end(anotherId)).rejects.toThrow("drain_not_owned");
  clock.expire();
  await expect
    .poll(() => calls)
    .toEqual(["pause schedules", "drain", "accept", "resume schedules"]);
  expect(await controller.status()).toMatchObject({ state: "accepting", drainId: null });
});

test("shutdown cancels expiry and does not allow a client to resume schedules", async () => {
  const { controller, clock, calls } = fixture();
  await controller.begin({ drainId, deadlineMs: 1000 });
  await controller.dispose();
  clock.expire();
  await expect(controller.end(drainId)).rejects.toThrow("daemon_stopping");
  await expect(controller.begin({ drainId, deadlineMs: 1000 })).rejects.toThrow("daemon_stopping");
  expect(calls).toEqual(["pause schedules", "drain", "drain"]);
  expect(await controller.status()).toMatchObject({ state: "shutdown" });
});

test("an expiry queued behind renewal cannot release the renewed lease", async () => {
  const { controller, clock, calls } = fixture();
  await controller.begin({ drainId, deadlineMs: 1000 });
  const renewal = controller.begin({ drainId, deadlineMs: 2000 });
  clock.expire();
  await renewal;
  // This request queues behind expiry, so its response observes the settled result.
  await controller.begin({ drainId, deadlineMs: 3000 });
  expect(calls).toEqual(["pause schedules", "drain"]);
  expect(await controller.status()).toMatchObject({ state: "draining", expiresAt: 3000 });
  await controller.dispose();
});

test("schedule pause failure leaves admission open, and resume failure remains visible", async () => {
  const failedPause = fixture({
    stop: async () => {
      throw new Error("pause failed");
    },
  });
  await expect(failedPause.controller.begin({ drainId, deadlineMs: 1000 })).rejects.toThrow(
    "pause failed",
  );
  expect(failedPause.calls).toEqual(["pause schedules", "resume schedules"]);
  expect(await failedPause.controller.status()).toMatchObject({
    state: "accepting",
    drainId: null,
  });
  const failedResume = fixture({
    start: async () => {
      throw new Error("resume failed");
    },
  });
  await failedResume.controller.begin({ drainId, deadlineMs: 1000 });
  failedResume.clock.expire();
  await expect.poll(() => failedResume.errors.length).toBe(1);
  expect(await failedResume.controller.status()).toMatchObject({
    state: "accepting",
    scheduleError: "resume failed",
  });
});

test("shutdown waits for an in-flight schedule resume and stops it before disposal completes", async () => {
  let resolveStart!: () => void;
  const starting = new Promise<void>((resolve) => {
    resolveStart = resolve;
  });
  const { controller, calls } = fixture({ start: () => starting });
  await controller.begin({ drainId, deadlineMs: 1000 });
  const ending = controller.end(drainId);
  await expect.poll(() => calls.includes("resume schedules")).toBe(true);
  let disposed = false;
  const disposing = controller.dispose().then(() => {
    disposed = true;
    return undefined;
  });
  await Promise.resolve();
  expect(disposed).toBe(false);
  resolveStart();
  await ending;
  await disposing;
  expect(calls).toEqual([
    "pause schedules",
    "drain",
    "accept",
    "resume schedules",
    "drain",
    "pause schedules",
  ]);
  expect(await controller.status()).toMatchObject({ state: "shutdown" });
});

test("schedule waiting consumes the deadline without ever freezing admission on expiry", async () => {
  const current = fixture({
    stop: async () => {
      current.clock.time = 1000;
    },
  });
  await expect(current.controller.begin({ drainId, deadlineMs: 1000 })).rejects.toThrow(
    "drain_timeout",
  );
  expect(current.calls).toEqual(["pause schedules", "resume schedules"]);
  expect(await current.controller.status()).toMatchObject({ state: "accepting", drainId: null });
});
