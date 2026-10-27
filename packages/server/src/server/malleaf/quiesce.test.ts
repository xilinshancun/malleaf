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

function fixture(
  overrides: {
    start?: () => Promise<void>;
    stop?: () => Promise<void>;
    idle?: boolean;
    release?: () => Promise<void>;
  } = {},
) {
  const clock = new ManualClock();
  const calls: string[] = [];
  const errors: unknown[] = [];
  let draining = false;
  const work = {
    running: overrides.idle ? [] : ["pending-turn"],
    pendingPermissions: [] as string[],
    pendingRegistrations: overrides.idle ? 0 : 1,
    pendingAdmissions: 0,
  };
  const pending = { deliveries: 0, schedules: 0 };
  const controller = createQuiesceController({
    agentManager: {
      beginDrain: () => {
        draining = true;
        calls.push("drain");
      },
      endDrain: () => {
        draining = false;
        calls.push("accept");
      },
      isDraining: () => draining,
      prepareForShutdown: () => {
        draining = false;
        calls.push("shutdown");
      },
      getDrainWork: () => work,
    },
    schedules: {
      pauseForDrain: () => {
        calls.push("pause schedules");
      },
      stop: async () => {
        calls.push("pause schedules");
        await overrides.stop?.();
      },
      resumeAfterDrain: async () => {
        calls.push("resume schedules");
        await overrides.start?.();
      },
      pendingRuns: () => pending.schedules,
    },
    releaseBootDrain: async () => {
      calls.push("persist release");
      await overrides.release?.();
    },
    pendingDeliveries: () => pending.deliveries,
    countResources: async () => ({ terminals: 2, scripts: 1 }),
    onError: (error) => {
      errors.push(error);
    },
    clock,
  });
  return {
    controller,
    clock,
    calls,
    errors,
    work,
    pending,
    unfreeze: () => {
      draining = false;
    },
  };
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

test("commit freezes admission permanently before asynchronous resource reporting", async () => {
  const { controller, clock, calls, errors } = fixture({ idle: true });
  await controller.begin({ drainId, deadlineMs: 1000 });
  const expiry = [...clock.callbacks][0];
  const committing = controller.commit(drainId);
  expiry(); // Expiry queued after commit must not restore admission.
  expect(await committing).toMatchObject({ state: "shutdown", drainId, expiresAt: 1000 });
  await expect(controller.end(drainId)).rejects.toThrow("daemon_stopping");
  await expect(controller.begin({ drainId, deadlineMs: 1000 })).rejects.toThrow("daemon_stopping");
  clock.time = 1001;
  clock.expire();
  await controller.dispose();
  expect(calls.filter((call) => call === "shutdown")).toHaveLength(1);
  expect(calls).not.toContain("accept");
  expect(calls).not.toContain("resume schedules");
  expect(errors).toEqual([]);
});

test.each(["running", "permissions", "registrations", "admissions", "deliveries", "schedules"])(
  "commit refuses outstanding %s and leaves the renewable lease intact",
  async (barrier) => {
    const { controller, clock, calls, work, pending } = fixture({ idle: true });
    await controller.begin({ drainId, deadlineMs: 1000 });
    if (barrier === "running") work.running.push("agent");
    if (barrier === "permissions") work.pendingPermissions.push("agent");
    if (barrier === "registrations") work.pendingRegistrations = 1;
    if (barrier === "admissions") work.pendingAdmissions = 1;
    if (barrier === "deliveries") pending.deliveries = 1;
    if (barrier === "schedules") pending.schedules = 1;
    const timer = [...clock.callbacks][0];
    await expect(controller.commit(drainId)).rejects.toThrow("drain_busy");
    expect(calls).not.toContain("shutdown");
    expect([...clock.callbacks]).toEqual([timer]);
    expect(await controller.status()).toMatchObject({ state: "draining", expiresAt: 1000 });
    await controller.dispose();
  },
);

test("commit rejects expired, wrong-owner and externally ended drains without freezing", async () => {
  const { controller, clock, calls, unfreeze } = fixture({ idle: true });
  await controller.begin({ drainId, deadlineMs: 1000 });
  await expect(controller.commit(anotherId)).rejects.toThrow("drain_not_active");
  clock.time = 1001; // Timer has not run yet; the deadline itself is authoritative.
  await expect(controller.commit(drainId)).rejects.toThrow("drain_timeout");
  expect(calls).not.toContain("shutdown");
  await controller.begin({ drainId, deadlineMs: 1000 });
  unfreeze();
  await expect(controller.commit(drainId)).rejects.toThrow("drain_not_active");
  expect(calls).not.toContain("shutdown");
  await controller.dispose();
});

test("expiry queued before commit wins and cannot be turned into an unowned stop", async () => {
  const { controller, clock, calls } = fixture({ idle: true });
  await controller.begin({ drainId, deadlineMs: 1000 });
  clock.expire();
  await expect(controller.commit(drainId)).rejects.toThrow("drain_not_active");
  expect(calls).toContain("accept");
  expect(calls).not.toContain("shutdown");
  expect(await controller.status()).toMatchObject({ state: "accepting" });
});

test("boot gate never expires or becomes a timed drain, and releases only after persistence", async () => {
  const { controller, clock, calls } = fixture({ idle: true });
  controller.adoptBootDrain(drainId);
  expect(clock.callbacks.size).toBe(0);
  clock.time = 1_000_000;
  expect(await controller.begin({ drainId, deadlineMs: 1000 })).toMatchObject({
    state: "draining",
    expiresAt: null,
  });
  expect(clock.callbacks.size).toBe(0);
  await expect(controller.end(anotherId)).rejects.toThrow("drain_not_owned");
  await expect(controller.begin({ drainId: anotherId, deadlineMs: 1000 })).rejects.toThrow(
    "drain_active",
  );
  expect(await controller.end(drainId)).toMatchObject({ state: "accepting" });
  await controller.end(drainId);
  expect(calls).toEqual([
    "pause schedules",
    "drain",
    "persist release",
    "accept",
    "resume schedules",
  ]);
});

test("failed boot release persistence keeps the gate closed and allows a retry", async () => {
  let rejectRelease = true;
  const { controller, calls } = fixture({
    idle: true,
    release: async () => {
      if (rejectRelease) throw new Error("disk full");
    },
  });
  controller.adoptBootDrain(drainId);
  await expect(controller.end(drainId)).rejects.toThrow("disk full");
  expect(await controller.status()).toMatchObject({ state: "draining", drainId, expiresAt: null });
  expect(calls).not.toContain("accept");
  rejectRelease = false;
  await controller.end(drainId);
  expect(calls).toContain("accept");
});

test("shutdown during boot release persistence cannot reopen admission", async () => {
  let release!: () => void;
  const persisting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { controller, calls } = fixture({ idle: true, release: () => persisting });
  controller.adoptBootDrain(drainId);
  const ending = controller.end(drainId);
  await expect.poll(() => calls.includes("persist release")).toBe(true);
  const disposing = controller.dispose();
  release();
  await ending;
  await disposing;
  expect(await controller.status()).toMatchObject({ state: "shutdown" });
  expect(calls).not.toContain("accept");
  expect(calls).not.toContain("resume schedules");
});

test("boot gate can commit without an expiry or a persisted release", async () => {
  const { controller, calls, clock } = fixture({ idle: true });
  controller.adoptBootDrain(drainId);
  clock.time = 1_000_000;
  expect(await controller.commit(drainId)).toMatchObject({ state: "shutdown", expiresAt: null });
  expect(calls).not.toContain("persist release");
  await expect(controller.end(drainId)).rejects.toThrow("daemon_stopping");
});
