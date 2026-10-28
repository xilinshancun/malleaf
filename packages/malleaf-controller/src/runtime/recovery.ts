import { verifyRuntimeAuthority } from "./authority.js";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { readDaemonInstance, type DaemonInstance } from "@getpaseo/server/daemon-control";
import { assertStoragePath } from "../isolation.js";
import { StorageError } from "../storage.js";
import { samePair, type SwitchTransaction } from "../runner/journal.js";
import {
  matchesRegisteredInstance,
  requireControllerToken,
  type InstanceLedgerState,
  type InstanceRegistration,
} from "../runner/instances.js";
import type { RuntimePair, RuntimePointer } from "../runner/pointer.js";

interface RecoveryState {
  home: string;
  pointer: RuntimePointer;
  transaction: SwitchTransaction | null;
  ledger: InstanceLedgerState;
}
export interface ObservedRuntime {
  home: string;
  instance: DaemonInstance;
}
export interface RecoveryPlan {
  action: "current" | "trial" | "committed" | "rollback" | "abort" | "paused" | "blocked";
  target: RuntimePair;
  attach: InstanceRegistration | null;
  stop: InstanceRegistration[];
}
export function epochHome(home: string, pair: RuntimePair) {
  return path.join(home, "data", pair.dataId);
}

export async function inspectRecovery(state: RecoveryState): Promise<RecoveryPlan> {
  state = { ...state, home: await realpath(state.home) };
  const homes = new Set<string>();
  for (const pair of [
    state.pointer.current,
    state.pointer.previous,
    state.pointer.trial?.pair,
    state.transaction?.baseline,
    state.transaction?.copySource,
    state.transaction?.candidate,
  ]) {
    if (pair) homes.add(epochHome(state.home, pair));
  }
  for (const registration of Object.values(state.ledger.registrations))
    if (registration) homes.add(registration.home);
  const live: ObservedRuntime[] = [];
  for (const home of homes) {
    assertStoragePath(home);
    const instance = await readDaemonInstance(home);
    if (instance) live.push({ home, instance });
  }
  const plan = classifyRecovery({ ...state, live });
  for (const registration of Object.values(state.ledger.registrations)) {
    if (registration?.instance)
      await verifyRuntimeAuthority(registration.home, requireControllerToken(registration));
  }
  return plan;
}

// Inventory and validate every instance before returning any permitted process
// action. In particular, intent without an acquired identity is not ownership.
function validateInventory(state: RecoveryState & { live: ObservedRuntime[] }) {
  const { home, pointer, transaction, ledger, live } = state;
  const registrations = Object.entries(ledger.registrations);
  for (const [role, registration] of registrations) {
    if (registration && registration.instance === null)
      throw new StorageError(
        "state_conflict",
        `Unresolved ${role} launch intent at ${registration.home}; inspect before recovery`,
      );
  }
  for (const [, registration] of registrations)
    if (registration?.instance) requireControllerToken(registration);
  const stop: InstanceRegistration[] = [];
  const production: InstanceRegistration[] = [];
  const productionHomes = new Set(
    [pointer.current, pointer.previous, pointer.trial?.pair, transaction?.candidate]
      .filter((pair) => pair !== null && pair !== undefined)
      .map((pair) => epochHome(home, pair)),
  );
  for (const observed of live) {
    const matches = registrations.filter(
      ([, registration]) =>
        registration && matchesRegisteredInstance(registration, observed.home, observed.instance),
    );
    const match = matches[0];
    if (matches.length !== 1 || !match?.[1])
      throw new StorageError(
        "state_conflict",
        `Unregistered runtime pid ${observed.instance.pid} at ${observed.home}`,
      );
    const [role, registration] = match;
    if (role === "preflight") {
      if (productionHomes.has(registration.home))
        throw new StorageError(
          "invalid_state",
          "Preflight registration overlaps a production epoch",
        );
      stop.push(registration);
    } else production.push(registration);
  }
  if (production.length > 1)
    throw new StorageError(
      "state_conflict",
      "Multiple production epochs have running daemons; refusing recovery",
    );
  return { stop, production };
}

function selectRecovery(state: RecoveryState, production: InstanceRegistration[]) {
  const { home, pointer, transaction } = state;
  if (transaction && transaction.pointerSeq > pointer.seq)
    throw new StorageError("invalid_state", "Journal claims a pointer commit that does not exist");

  let action: RecoveryPlan["action"] = "current";
  let target = pointer.current;
  if (pointer.trial) {
    if (
      !transaction ||
      pointer.trial.switchId !== transaction.switchId ||
      pointer.trial.candidateToken !== transaction.switchToken ||
      !samePair(pointer.trial.pair, transaction.candidate) ||
      !samePair(pointer.current, transaction.baseline)
    )
      throw new StorageError("invalid_state", "Trial selection does not match the switch journal");
    const trialHome = epochHome(home, pointer.trial.pair);
    const alive = production.some((registration) => registration.home === trialHome);
    action = transaction.step === "reverting" || !alive ? "rollback" : "trial";
    if (action === "trial") target = pointer.trial.pair;
  } else if (transaction) {
    if (samePair(pointer.current, transaction.candidate)) action = "committed";
    else if (!samePair(pointer.current, transaction.baseline))
      throw new StorageError(
        "invalid_state",
        "Current pair matches neither the baseline nor the candidate",
      );
    else if (transaction.step === "kept")
      throw new StorageError(
        "invalid_state",
        "Journal claims keep but the pointer still selects the baseline",
      );
    else if (
      [
        "stopping",
        "stopped",
        "cloning",
        "cloned",
        "starting",
        "probing",
        "trial",
        "committing",
        "reverting",
      ].includes(transaction.step)
    )
      action = "rollback";
    else if (["requested", "preflight", "preflight_ok", "draining"].includes(transaction.step))
      action = "abort";
    else if (transaction.step === "drain_timeout") action = "paused";
    else if (transaction.step === "blocked") action = "blocked";
  }

  return { action, target };
}

export function classifyRecovery(state: RecoveryState & { live: ObservedRuntime[] }): RecoveryPlan {
  const { home, transaction } = state;
  const { stop, production } = validateInventory(state);
  const { action, target } = selectRecovery(state, production);
  const running = production[0];
  let attach: InstanceRegistration | null = null;
  if (running) {
    if (running.home === epochHome(home, target) && running.buildId === target.buildId)
      attach = running;
    else if (
      action === "rollback" &&
      transaction &&
      running.home === epochHome(home, transaction.candidate) &&
      running.buildId === transaction.candidate.buildId
    )
      stop.push(running);
    else
      throw new StorageError(
        "identity_conflict",
        "Running epoch is not part of the permitted recovery",
      );
  }
  return { action, target, attach, stop };
}
