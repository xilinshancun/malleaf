import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { BUILTIN_PROVIDER_IDS } from "@getpaseo/protocol/provider-manifest";
import type { DaemonInstance } from "@getpaseo/server/daemon-control";
import type { MalleafQuiesceStatus } from "@getpaseo/protocol/malleaf/quiesce";
import { createRuntimeFixture, removeFixture } from "../test-fixtures/runtime.js";
import { openPointerStore } from "../runner/pointer.js";
import { openSwitchJournal } from "../runner/journal.js";
import { openInstanceLedger } from "../runner/instances.js";
import { createIsolatedActivation } from "./activation.js";
import { type RuntimeHandle } from "./daemon.js";

const fake = vi.hoisted(() => ({
  live: new Map<string, RuntimeHandle>(),
  status: new Map<string, MalleafQuiesceStatus>(),
  events: [] as string[],
  fail: null as null | { dataId: string; cleanup: "verified" | "unverified" },
  ordinal: 0,
  failBootEnd: false,
}));

vi.mock("./daemon.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./daemon.js")>();
  async function stop(options: { daemonHome: string; instance: DaemonInstance }) {
    const current = fake.live.get(options.daemonHome);
    if (current && current.instance.startedAt !== options.instance.startedAt)
      throw new Error("refusing to stop a replacement");
    fake.events.push(`stop:${path.basename(options.daemonHome)}`);
    fake.live.delete(options.daemonHome);
    await rm(path.join(options.daemonHome, "paseo.pid"), { force: true });
  }
  return {
    ...actual,
    stopRuntimeInstance: stop,
    attachRuntime: async (options: { daemonHome: string; expected: DaemonInstance }) => {
      const handle = fake.live.get(options.daemonHome);
      if (!handle || handle.instance.startedAt !== options.expected.startedAt)
        throw new Error("wrong identity");
      fake.events.push(`attach:${path.basename(options.daemonHome)}`);
      return handle;
    },
    launchRuntime: async (options: {
      daemonHome: string;
      environment: NodeJS.ProcessEnv;
      recordInstance(instance: DaemonInstance): Promise<void>;
    }) => {
      const home = options.daemonHome;
      const dataId = path.basename(home);
      fake.events.push(`start:${dataId}`);
      if (fake.fail?.dataId === dataId && fake.fail.cleanup === "unverified") {
        fake.fail = null;
        throw new actual.RuntimeLaunchError("unverified", new Error("before acquired"));
      }
      const instance = {
        pid: process.pid,
        startedAt: new Date(Date.now() + ++fake.ordinal).toISOString(),
        hostname: os.hostname(),
        uid: process.getuid?.() ?? 0,
        listen: "127.0.0.1:1",
      };
      await mkdir(home, { recursive: true });
      await writeFile(path.join(home, "paseo.pid"), JSON.stringify(instance));
      await options.recordInstance(instance);
      const status: MalleafQuiesceStatus = {
        state: options.environment.MALLEAF_BOOT_DRAIN_ID ? "draining" : "accepting",
        drainId: options.environment.MALLEAF_BOOT_DRAIN_ID ?? null,
        expiresAt: null,
        running: [],
        pendingPermissions: [],
        pendingRegistrations: 0,
        pendingAdmissions: 0,
        pendingDeliveries: 0,
        pendingScheduleRuns: 0,
        terminals: 0,
        scripts: 0,
        scheduleError: null,
      };
      fake.status.set(home, status);
      const handle = {
        instance,
        client: {
          supportsMalleafQuiesceCommit: () => true,
          supportsMalleafBootDrain: () => true,
          close: async () => {},
          quiesceDaemon: async (input: {
            action: string;
            drainId?: string;
            deadlineMs?: number;
          }) => {
            fake.events.push(`rpc:${dataId}:${input.action}`);
            if (input.action === "begin")
              Object.assign(status, {
                state: "draining",
                drainId: input.drainId,
                expiresAt: Date.now() + (input.deadlineMs ?? 1000),
              });
            if (input.action === "commit") status.state = "shutdown";
            if (input.action === "end") {
              if (fake.failBootEnd && status.expiresAt === null && status.state === "draining") {
                fake.failBootEnd = false;
                throw new Error("boot release write failed");
              }
              Object.assign(status, { state: "accepting", drainId: null, expiresAt: null });
            }
            return { ...status };
          },
        },
        stop: () => stop({ daemonHome: home, instance }),
      } as unknown as RuntimeHandle;
      fake.live.set(home, handle);
      if (fake.fail?.dataId === dataId) {
        fake.fail = null;
        await stop({ daemonHome: home, instance });
        throw new actual.RuntimeLaunchError("verified", new Error("after acquired"), instance);
      }
      return handle;
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  fake.live.clear();
  fake.status.clear();
  fake.events.length = 0;
  fake.fail = null;
  fake.failBootEnd = false;
  for (const root of roots.splice(0)) await removeFixture(root);
});

async function fixture() {
  const f = await createRuntimeFixture();
  roots.push(f.root);
  const disabled = { enabled: false };
  const config = {
    pluginsEnabled: false,
    daemon: { relay: disabled, enableTerminalAgentHooks: false },
    agents: {
      providers: {
        ...Object.fromEntries(BUILTIN_PROVIDER_IDS.map((id) => [id, disabled])),
        mock: { enabled: true },
      },
    },
    features: { dictation: disabled, voiceMode: disabled, webUi: disabled },
  };
  await writeFile(path.join(f.root, "seed/config.json"), JSON.stringify(config));
  await writeFile(path.join(f.root, "seed/note.txt"), "original baseline bytes");
  const baseline = await f.pair("baseline");
  const artifact = await f.pair("artifact");
  const pointer = await openPointerStore({ ...f, initial: baseline });
  const journal = await openSwitchJournal(f);
  const ledger = await openInstanceLedger(f);
  const osHome = path.join(f.root, "os-home");
  await mkdir(osHome);
  const options = {
    ...f,
    acceptanceRoot: f.root,
    pointer,
    journal,
    ledger,
    environment: { HOME: osHome, MALLEAF_TEST: "1" },
    shared: {
      plugins: path.join(f.home, "plugins"),
      worktrees: path.join(f.home, "worktrees"),
      models: path.join(f.home, "models"),
    },
    policy: { schemaVersion: 1 as const, entries: {} },
    drainDeadlineMs: 1000,
  };
  const controller = await createIsolatedActivation(options);
  const initial = await controller.recover();
  const request = {
    switchId: randomUUID(),
    switchToken: randomUUID(),
    drainId: randomUUID(),
    copySource: baseline,
    candidate: { buildId: artifact.buildId, dataId: "candidate" },
  };
  return { ...options, baseline, controller, initial, request };
}

test("healthy trial, keep and repeated request preserve the original epoch", async () => {
  const f = await fixture();
  const trial = await f.controller.activate(f.request);
  expect(trial.pointer.current).toEqual(f.baseline);
  expect(trial.pointer.trial?.pair).toEqual(f.request.candidate);
  expect(trial.transaction?.step).toBe("trial");
  expect((await f.ledger.read()).registrations.candidate?.bootDrainId).toBeTypeOf("string");
  expect((await f.ledger.read()).registrations.candidate?.bootDrainId).not.toBe(
    f.request.switchToken,
  );
  expect(fake.status.get(path.join(await realpath(f.home), "data/candidate"))?.state).toBe(
    "accepting",
  );
  const kept = await f.controller.keep(f.request.switchId);
  expect(kept.pointer).toMatchObject({
    current: f.request.candidate,
    previous: f.baseline,
    trial: null,
  });
  const events = [...fake.events];
  await f.controller.activate(f.request);
  expect(fake.events).toEqual(events);
  expect(await readFile(path.join(f.home, "data/baseline/note.txt"), "utf8")).toBe(
    "original baseline bytes",
  );
  await expect(f.controller.activate({ ...f.request, drainId: randomUUID() })).rejects.toThrow(
    "different arguments",
  );
});

test("verified candidate launch failure restarts only baseline and records rollback", async () => {
  const f = await fixture();
  fake.fail = { dataId: "candidate", cleanup: "verified" };
  const result = await f.controller.activate(f.request);
  expect(result.transaction?.step).toBe("rolled_back");
  expect(result.pointer).toMatchObject({ current: f.baseline, trial: null });
  expect(fake.events.filter((event) => event === "start:baseline")).toHaveLength(2);
  expect((await f.ledger.read()).registrations.candidate).toBeUndefined();
});

test("unverified launch retains its intent and cannot automatically restart another daemon", async () => {
  const f = await fixture();
  fake.fail = { dataId: "candidate", cleanup: "unverified" };
  await expect(f.controller.activate(f.request)).rejects.toThrow(
    "Unresolved candidate launch intent",
  );
  expect((await f.ledger.read()).registrations.candidate?.instance).toBeNull();
  const before = [...fake.events];
  await expect(f.controller.recover()).rejects.toThrow("Unresolved candidate launch intent");
  expect(fake.events).toEqual(before);
  expect(fake.events.filter((event) => event === "start:baseline")).toHaveLength(1);
});

test("controller loss after commit restarts the frozen baseline instead of attaching it as healthy", async () => {
  const f = await fixture();
  await f.journal.begin({ ...f.request, baseline: f.baseline }, await f.pointer.read());
  for (const step of ["preflight", "preflight_ok", "draining"] as const)
    await f.journal.advance(f.request.switchId, step);
  const client = f.initial.runtime!.client;
  await client.quiesceDaemon({ action: "begin", drainId: f.request.drainId, deadlineMs: 1000 });
  await client.quiesceDaemon({ action: "commit", drainId: f.request.drainId });
  await f.controller.disconnect();
  const recovered = await (await createIsolatedActivation(f)).recover();
  expect(recovered.transaction?.step).toBe("aborted");
  expect(fake.events.filter((event) => event === "stop:baseline")).toHaveLength(1);
  expect(fake.events.filter((event) => event === "start:baseline")).toHaveLength(2);
  expect((await recovered.runtime!.client.quiesceDaemon({ action: "status" })).state).toBe(
    "accepting",
  );
});

test("a journal failure after keep never rolls the committed pointer back", async () => {
  const f = await fixture();
  await f.controller.activate(f.request);
  const failing = await createIsolatedActivation({
    ...f,
    journal: {
      ...f.journal,
      afterPointer: async (id, step, operation) => {
        if (step !== "kept") return f.journal.afterPointer(id, step, operation);
        await operation();
        throw new Error("journal unavailable after pointer commit");
      },
    },
  });
  await failing.recover();
  const before = [...fake.events];
  await expect(failing.keep(f.request.switchId)).rejects.toThrow("journal unavailable");
  expect((await f.pointer.read()).current).toEqual(f.request.candidate);
  expect(fake.events.slice(before.length)).toEqual(["rpc:candidate:status"]);
  const recovered = await (await createIsolatedActivation(f)).recover();
  expect(recovered.transaction?.step).toBe("kept");
  expect(recovered.pointer.current).toEqual(f.request.candidate);
  expect(fake.events.filter((event) => event === "start:baseline")).toHaveLength(1);
});

test("revert waits for the active trial, then returns to baseline without changing its data", async () => {
  const f = await fixture();
  await f.controller.activate(f.request);
  const home = path.join(await realpath(f.home), "data/candidate");
  const status = fake.status.get(home)!;
  status.running = ["accepted-turn"];
  const paused = await f.controller.revert(f.request.switchId);
  expect(paused).toHaveProperty("paused", true);
  expect(paused.pointer.trial?.pair).toEqual(f.request.candidate);
  expect(fake.events).not.toContain("stop:candidate");
  status.running = [];
  const reverted = await f.controller.revert(f.request.switchId);
  expect(reverted.transaction?.step).toBe("rolled_back");
  expect(reverted.pointer).toMatchObject({ current: f.baseline, trial: null });
  expect(await readFile(path.join(f.home, "data/baseline/note.txt"), "utf8")).toBe(
    "original baseline bytes",
  );
});

test.each(["keep", "revert"] as const)(
  "interrupted keep intent remains a trial and allows explicit %s",
  async (next) => {
    const f = await fixture();
    await f.controller.activate(f.request);
    await f.journal.advance(f.request.switchId, "committing");
    await f.controller.disconnect();
    const controller = await createIsolatedActivation(f);
    const recovered = await controller.recover();
    expect(recovered.transaction?.step).toBe("committing");
    expect(recovered.pointer.trial?.pair).toEqual(f.request.candidate);
    const settled = await controller[next](f.request.switchId);
    expect(settled.transaction?.step).toBe(next === "keep" ? "kept" : "rolled_back");
  },
);

test("returning to previous clones its data into a new epoch while rollback keeps the true baseline", async () => {
  const f = await fixture();
  await f.controller.activate(f.request);
  await f.controller.keep(f.request.switchId);
  await writeFile(path.join(f.home, "data/candidate/note.txt"), "new current changes");
  const back = {
    switchId: randomUUID(),
    switchToken: randomUUID(),
    drainId: randomUUID(),
    copySource: f.baseline,
    candidate: { buildId: f.baseline.buildId, dataId: "return-trial" },
  };
  const trial = await f.controller.activate(back);
  expect(trial.transaction?.baseline).toEqual(f.request.candidate);
  expect(trial.transaction?.copySource).toEqual(f.baseline);
  expect(await readFile(path.join(f.home, "data/return-trial/note.txt"), "utf8")).toBe(
    "original baseline bytes",
  );
  const reverted = await f.controller.revert(back.switchId);
  expect(reverted.pointer.current).toEqual(f.request.candidate);
  expect(await readFile(path.join(f.home, "data/candidate/note.txt"), "utf8")).toBe(
    "new current changes",
  );
});

test("a durable trial survives a failed journal publication and is recovered without stop", async () => {
  const f = await fixture();
  const failing = await createIsolatedActivation({
    ...f,
    journal: {
      ...f.journal,
      afterPointer: async (id, step, operation) => {
        if (step !== "trial") return f.journal.afterPointer(id, step, operation);
        await operation();
        throw new Error("trial journal publication failed");
      },
    },
  });
  await failing.recover();
  await expect(failing.activate(f.request)).rejects.toThrow("trial journal publication failed");
  expect(fake.status.get(path.join(await realpath(f.home), "data/candidate"))).toMatchObject({
    state: "draining",
    drainId: (await f.ledger.read()).registrations.candidate?.bootDrainId,
    expiresAt: null,
  });
  expect((await f.pointer.read()).trial?.pair).toEqual(f.request.candidate);
  const recovered = await (await createIsolatedActivation(f)).recover();
  expect(recovered.transaction?.step).toBe("trial");
  expect(fake.events).not.toContain("stop:candidate");
});

test("drain timeout has explicit retry and abort exits before any stop", async () => {
  const f = await fixture();
  const status = fake.status.get(path.join(await realpath(f.home), "data/baseline"))!;
  status.running = ["accepted"];
  const paused = await f.controller.activate(f.request);
  expect(paused.transaction?.step).toBe("drain_timeout");
  expect(fake.events).not.toContain("stop:baseline");
  status.running = [];
  expect((await f.controller.activate(f.request)).transaction?.step).toBe("trial");
  await f.controller.revert(f.request.switchId);
  const second = {
    ...f.request,
    switchId: randomUUID(),
    candidate: { ...f.request.candidate, dataId: "second" },
  };
  const resumed = fake.status.get(path.join(await realpath(f.home), "data/baseline"))!;
  resumed.running = ["accepted"];
  expect((await f.controller.activate(second)).transaction?.step).toBe("drain_timeout");
  expect((await f.controller.abort(second.switchId)).transaction?.step).toBe("aborted");
});

test("a selected current boot gate releases with ledger ownership after the journal changes", async () => {
  const f = await fixture();
  await f.controller.activate(f.request);
  await f.controller.keep(f.request.switchId);
  const registration = (await f.ledger.read()).registrations.baseline;
  expect(registration?.bootDrainId).toBeTypeOf("string");
  const next = {
    ...f.request,
    switchId: randomUUID(),
    switchToken: randomUUID(),
    drainId: randomUUID(),
    baseline: f.request.candidate,
    copySource: f.request.candidate,
    candidate: { buildId: f.baseline.buildId, dataId: "another-epoch" },
  };
  await f.journal.begin(next, await f.pointer.read());
  const status = fake.status.get(path.join(await realpath(f.home), "data/candidate"))!;
  Object.assign(status, { state: "draining", drainId: registration?.bootDrainId, expiresAt: null });
  await f.controller.disconnect();
  const recovered = await (await createIsolatedActivation(f)).recover();
  expect(recovered.transaction?.step).toBe("aborted");
  expect(status.state).toBe("accepting");
});

test("trial can revert a failed boot release without first opening admission or reconnecting", async () => {
  const f = await fixture();
  fake.failBootEnd = true;
  await expect(f.controller.activate(f.request)).rejects.toThrow("boot release write failed");
  expect((await f.pointer.read()).trial?.pair).toEqual(f.request.candidate);
  expect(fake.status.get(path.join(await realpath(f.home), "data/candidate"))?.state).toBe(
    "draining",
  );
  const reverted = await f.controller.revert(f.request.switchId);
  expect(reverted.transaction?.step).toBe("rolled_back");
  expect(reverted.pointer.current).toEqual(f.baseline);
  expect(fake.events).not.toContain("rpc:candidate:begin");
  expect(fake.events).toContain("rpc:candidate:commit");
});
