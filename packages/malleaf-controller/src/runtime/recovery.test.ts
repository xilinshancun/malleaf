import { publishRuntimeAuthority } from "./authority.js";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { classifyRecovery, epochHome, inspectRecovery } from "./recovery.js";
import { initialDocument } from "../runner/document.js";
import type { RuntimePointer } from "../runner/pointer.js";
import type { InstanceLedgerState, InstanceRegistration } from "../runner/instances.js";
import type { SwitchStep, SwitchTransaction } from "../runner/journal.js";

function fixture() {
  const home = path.resolve("/isolated/runtime");
  const baseline = { buildId: "a".repeat(64), dataId: "baseline" };
  const candidate = { buildId: "b".repeat(64), dataId: "candidate" };
  const previous = { buildId: "c".repeat(64), dataId: "previous" };
  const transaction: SwitchTransaction = {
    baseline,
    candidate,
    copySource: previous,
    switchId: randomUUID(),
    switchToken: randomUUID(),
    drainId: randomUUID(),
    step: "probing",
    pointerSeq: 0,
    error: null,
  };
  const pointer: RuntimePointer = {
    ...initialDocument(),
    current: baseline,
    previous,
    trial: null,
    writer: { pid: 1, token: "controller" },
  };
  const ledger: InstanceLedgerState = { ...initialDocument(), registrations: {} };
  function registration(pair = candidate, pid = 12345): InstanceRegistration {
    return {
      home: epochHome(home, pair),
      buildId: pair.buildId,
      token: randomUUID(),
      controllerToken: randomBytes(32).toString("hex"),
      at: new Date().toISOString(),
      instance: {
        pid,
        startedAt: new Date().toISOString(),
        hostname: "fixture",
        uid: 1,
        listen: "127.0.0.1:1234",
      },
    };
  }
  function observed(registered: InstanceRegistration) {
    if (!registered.instance) throw new Error("Fixture requires an acquired instance");
    return { home: registered.home, instance: registered.instance };
  }
  return { home, pointer, ledger, transaction, registration, observed };
}

test.each<SwitchStep>([
  "stopping",
  "stopped",
  "cloning",
  "cloned",
  "starting",
  "probing",
  "reverting",
])("interrupted %s rolls back to baseline, never to a distinct copy source", (step) => {
  const f = fixture();
  const registered = f.registration();
  f.ledger.registrations.candidate = registered;
  const plan = classifyRecovery({
    ...f,
    transaction: { ...f.transaction, step },
    live: [f.observed(registered)],
  });
  expect(plan).toMatchObject({
    action: "rollback",
    target: f.transaction.baseline,
    attach: null,
    stop: [registered],
  });
  expect(plan.target).not.toEqual(f.transaction.copySource);
});

test("pointer commit wins even when the journal still says committing", () => {
  const f = fixture();
  f.pointer.current = f.transaction.candidate;
  f.pointer.previous = f.transaction.baseline;
  f.pointer.seq = 2;
  f.transaction.step = "committing";
  const registered = f.registration();
  f.ledger.registrations.candidate = registered;
  expect(classifyRecovery({ ...f, live: [f.observed(registered)] })).toMatchObject({
    action: "committed",
    target: f.transaction.candidate,
    attach: registered,
    stop: [],
  });
});

test("a durable trial is retained after a lagging journal, but a dead trial rolls back", () => {
  const f = fixture();
  f.pointer.trial = {
    pair: f.transaction.candidate,
    switchId: f.transaction.switchId,
    candidateToken: f.transaction.switchToken,
    since: new Date().toISOString(),
  };
  f.pointer.seq = 1;
  const registered = f.registration();
  f.ledger.registrations.candidate = registered;
  expect(classifyRecovery({ ...f, live: [f.observed(registered)] })).toMatchObject({
    action: "trial",
    attach: registered,
  });
  expect(classifyRecovery({ ...f, live: [] })).toMatchObject({
    action: "rollback",
    target: f.pointer.current,
  });
});

test("preflight and baseline may coexist, while two production epochs are refused", () => {
  const f = fixture();
  f.transaction.step = "preflight";
  const baseline = f.registration(f.transaction.baseline);
  const preflight = {
    ...f.registration(f.transaction.candidate, 12346),
    home: path.resolve("/isolated/scratch/daemon"),
  };
  f.ledger.registrations = { baseline, preflight };
  const plan = classifyRecovery({ ...f, live: [f.observed(baseline), f.observed(preflight)] });
  expect(plan).toMatchObject({ action: "abort", attach: baseline, stop: [preflight] });
  const candidate = f.registration(f.transaction.candidate, 12347);
  f.ledger.registrations.candidate = candidate;
  expect(() =>
    classifyRecovery({ ...f, live: [f.observed(baseline), f.observed(candidate)] }),
  ).toThrow("Multiple production epochs");
});

test("unknown candidate before beginTrial and unresolved launch intentions fail closed", () => {
  const f = fixture();
  const registered = f.registration();
  expect(() => classifyRecovery({ ...f, live: [f.observed(registered)] })).toThrow(
    "Unregistered runtime",
  );
  f.ledger.registrations.candidate = { ...registered, instance: null };
  expect(() => classifyRecovery({ ...f, live: [] })).toThrow("Unresolved candidate launch intent");
  expect(() => classifyRecovery({ ...f, live: [f.observed(registered)] })).toThrow(
    "Unresolved candidate launch intent",
  );
});

test("mismatched identities and journal facts ahead of the pointer are rejected", () => {
  const f = fixture();
  f.transaction.pointerSeq = 1;
  expect(() => classifyRecovery({ ...f, live: [] })).toThrow("pointer commit that does not exist");
  f.transaction.pointerSeq = 0;
  f.transaction.step = "kept";
  expect(() => classifyRecovery({ ...f, live: [] })).toThrow("pointer still selects the baseline");
  f.pointer.current = { buildId: "d".repeat(64), dataId: "foreign" };
  expect(() => classifyRecovery({ ...f, live: [] })).toThrow(
    "neither the baseline nor the candidate",
  );
});

test.each([
  ["drain_timeout", "paused"],
  ["blocked", "blocked"],
] as const)(
  "%s remains an explicit decision instead of looking like normal current recovery",
  (step, action) => {
    const f = fixture();
    f.transaction.step = step;
    expect(classifyRecovery({ ...f, live: [] })).toMatchObject({
      action,
      target: f.transaction.baseline,
    });
  },
);

test("recovery resolves a home alias before matching a registered live instance", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "malleaf-recovery-alias-")));
  try {
    const f = fixture();
    f.home = path.join(root, "home");
    const daemonHome = epochHome(f.home, f.pointer.current);
    await mkdir(daemonHome, { recursive: true });
    const alias = path.join(root, "alias");
    await symlink(f.home, alias, "junction");
    const registration = {
      ...f.registration(f.pointer.current),
      home: daemonHome,
      instance: {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        hostname: os.hostname(),
        uid: process.getuid?.() ?? 0,
        listen: null,
      },
    };
    await publishRuntimeAuthority(daemonHome, registration.controllerToken!, () => {});
    // Observation only: no server is started and no signal is sent to this test process.
    await writeFile(path.join(daemonHome, "paseo.pid"), JSON.stringify(registration.instance));
    f.ledger.registrations.baseline = registration;
    const plan = await inspectRecovery({ ...f, home: alias, transaction: null });
    expect(plan).toMatchObject({ action: "current", attach: registration, stop: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a legacy registration without controller authority cannot authorize recovery actions", () => {
  const f = fixture();
  const registered = f.registration();
  delete registered.controllerToken;
  f.ledger.registrations.candidate = registered;
  expect(() => classifyRecovery({ ...f, live: [f.observed(registered)] })).toThrow(
    "no controller authority",
  );
});
