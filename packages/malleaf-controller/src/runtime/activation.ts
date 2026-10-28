import { requireControllerToken } from "../runner/instances.js";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, realpath, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BUILTIN_PROVIDER_IDS } from "@getpaseo/protocol/provider-manifest";
import { z } from "zod";
import { isSameDaemonInstance, readDaemonInstance } from "@getpaseo/server/daemon-control";
import { executeEpochCopy, planEpochCopy } from "../data/epoch.js";
import type { DataPolicy, SharedDirectories } from "../data/policy.js";
import type { openPointerStore, RuntimePair } from "../runner/pointer.js";
import {
  samePair,
  terminalSwitch,
  type openSwitchJournal,
  type SwitchRequest,
  type SwitchTransaction,
} from "../runner/journal.js";
import type {
  openInstanceLedger,
  InstanceRegistration,
  InstanceRole,
} from "../runner/instances.js";
import { containedRealPath, exists, isWithin, readJson, StorageError } from "../storage.js";
import {
  attachRuntime,
  launchRuntime,
  RuntimeLaunchError,
  stopRuntimeInstance,
  type RuntimeHandle,
} from "./daemon.js";
import { drainAndCommit, hasPendingDrainWork } from "./drain.js";
import { preparePreflight } from "./preflight.js";
import { epochHome, inspectRecovery, type RecoveryPlan } from "./recovery.js";
import { assertAcceptanceBoundary, assertStoragePath } from "../isolation.js";
import { verifyCandidateController } from "./controller-probe.js";

type PointerStore = Awaited<ReturnType<typeof openPointerStore>>;
type Journal = Awaited<ReturnType<typeof openSwitchJournal>>;
type Ledger = Awaited<ReturnType<typeof openInstanceLedger>>;
type ActivationRequest = Omit<SwitchRequest, "baseline">;

// Deliberately not exported through the package or exposed by CLI/UI. The first
// process slice only operates disposable mock acceptance homes. Real-user
// activation also needs the candidate boot gate and terminal/script admission.
export async function createIsolatedActivation(options: {
  acceptanceRoot: string;
  home: string;
  environment: NodeJS.ProcessEnv;
  pointer: PointerStore;
  journal: Journal;
  ledger: Ledger;
  shared: SharedDirectories;
  policy: DataPolicy;
  assertOwned(): void;
  drainDeadlineMs?: number;
}) {
  const home = await realpath(options.home);
  const root = await realpath(options.acceptanceRoot);
  assertAcceptanceBoundary(root, home);
  if (!options.environment.HOME)
    throw new StorageError("unsafe_path", "Activation acceptance requires an explicit fake HOME");
  const temporaryRoot = await realpath(os.tmpdir());
  const osHome = await realpath(options.environment.HOME ?? "");
  if (
    !isWithin(temporaryRoot, root) ||
    root === temporaryRoot ||
    !isWithin(root, home) ||
    !isWithin(root, osHome) ||
    options.environment.MALLEAF_TEST !== "1"
  )
    throw new StorageError(
      "unsafe_path",
      "Activation acceptance requires a disposable home and isolated OS environment",
    );
  const { pointer, journal, ledger, assertOwned } = options;
  let running: { pair: RuntimePair; role: InstanceRole; handle: RuntimeHandle } | null = null;
  let tail = Promise.resolve();
  const deadlineMs = options.drainDeadlineMs ?? 30_000;
  const clientId = `malleaf-controller-${randomUUID()}`;
  const slot = (pair: Pick<RuntimePair, "buildId">) => path.join(home, "versions", pair.buildId);
  const target = (pair: RuntimePair, daemonHome = epochHome(home, pair)) => ({
    slotDirectory: slot(pair),
    buildId: pair.buildId,
    daemonHome,
    clientId,
    assertOwned,
  });

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const operationResult = tail.then(() => {
      assertOwned();
      return operation();
    });
    tail = operationResult.then(
      () => undefined,
      () => undefined,
    );
    return operationResult;
  }
  function decision(transaction: SwitchTransaction) {
    return { switchId: transaction.switchId, candidateToken: transaction.switchToken };
  }
  async function transactionFor(switchId: string) {
    const transaction = (await journal.read()).transaction;
    if (!transaction || transaction.switchId !== switchId)
      throw new StorageError("state_conflict", "Switch does not match the durable transaction");
    return transaction;
  }
  async function roleOf(registration: InstanceRegistration): Promise<InstanceRole> {
    const entries = Object.entries((await ledger.read()).registrations);
    const match = entries.find(([, item]) => item?.token === registration.token);
    if (!match) throw new StorageError("state_conflict", "Instance registration disappeared");
    return match[0] as InstanceRole;
  }
  async function stopRegistered(registration: InstanceRegistration) {
    if (!registration.instance)
      throw new StorageError("state_conflict", "Cannot stop an unresolved intent");
    const role = await roleOf(registration);
    await stopRuntimeInstance({
      daemonHome: registration.home,
      clientId,
      assertOwned,
      instance: registration.instance,
      controllerToken: requireControllerToken(registration),
    });
    await ledger.clear(role, registration.token);
    if (running?.role === role) {
      await running.handle.client.close();
      running = null;
    }
  }
  async function clearStopped(role: InstanceRole) {
    const registration = (await ledger.read()).registrations[role];
    if (!registration) return;
    if (!registration.instance || (await readDaemonInstance(registration.home)))
      throw new StorageError(
        "state_conflict",
        `Unresolved or live ${role} registration prevents launch`,
      );
    // A missing lock alone cannot prove a recorded supervisor has exited. A
    // reused/live PID is conservatively diagnostic, never a reason to kill it.
    try {
      process.kill(registration.instance.pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") {
        await ledger.clear(role, registration.token);
        return;
      }
      throw error;
    }
    throw new StorageError(
      "state_conflict",
      `Recorded ${role} PID is still alive without its lock; inspect before recovery`,
    );
  }
  async function launch(
    role: InstanceRole,
    pair: RuntimePair,
    daemonHome = epochHome(home, pair),
    environment = options.environment,
    bootDrainId?: string,
  ) {
    await assertAcceptanceEpoch(daemonHome);
    await clearStopped(role);
    const token = randomUUID();
    const controllerToken = randomBytes(32).toString("hex");
    await ledger.intent(role, {
      home: daemonHome,
      buildId: pair.buildId,
      token,
      bootDrainId,
      controllerToken,
    });
    try {
      const handle = await launchRuntime({
        ...target(pair, daemonHome),
        controllerToken,
        environment: {
          ...environment,
          MALLEAF_HOME: home,
          MALLEAF_BOOT_DRAIN_ID: bootDrainId,
          MALLEAF_CLI: path.join(slot(pair), "packages/cli/bin/paseo"),
        },
        recordInstance: async (instance) => {
          await ledger.acquired(role, token, instance);
        },
      });
      await ledger.acquired(role, token, handle.instance);
      return handle;
    } catch (error) {
      assertOwned();
      if (
        error instanceof RuntimeLaunchError &&
        error.cleanup === "verified" &&
        !(await readDaemonInstance(daemonHome))
      )
        await ledger.clear(role, token);
      throw error;
    }
  }
  async function startBaseline(pair: RuntimePair) {
    const handle = await launch("baseline", pair);
    running = { pair, role: "baseline", handle };
    return handle;
  }
  function requireRunning(pair: RuntimePair) {
    if (!running || !samePair(running.pair, pair))
      throw new StorageError("state_conflict", "Recover the selected runtime before switching");
    return running;
  }
  async function stopRunning(pair: RuntimePair) {
    const current = requireRunning(pair);
    const registration = (await ledger.read()).registrations[current.role];
    if (!registration)
      throw new StorageError("state_conflict", "Running daemon lacks a registration");
    await stopRegistered(registration);
  }
  async function preflight(transaction: SwitchTransaction) {
    await journal.advance(transaction.switchId, "preflight");
    let scratch: Awaited<ReturnType<typeof preparePreflight>>;
    try {
      await verifyCandidateController({
        slotDirectory: slot(transaction.candidate),
        buildId: transaction.candidate.buildId,
        home,
        acceptanceRoot: root,
        environment: options.environment,
        assertOwned,
      });
      // The controller's fake HOME is inside root. A scratch parent must be a
      // sibling of that HOME, never an ancestor of its protected product paths.
      const scratchRoot = path.join(root, "tmp");
      assertStoragePath(scratchRoot);
      await mkdir(scratchRoot, { recursive: true });
      await containedRealPath(root, scratchRoot);
      scratch = await preparePreflight({
        slotDirectory: slot(transaction.candidate),
        scratchRoot,
      });
    } catch (error) {
      await journal.advance(transaction.switchId, "aborted", String(error));
      throw error;
    }
    let safeToDispose = false;
    try {
      const handle = await launch(
        "preflight",
        transaction.candidate,
        scratch.daemonHome,
        scratch.env,
      );
      try {
        if (!handle.client.supportsMalleafQuiesceCommit())
          throw new StorageError("unsupported_schema", "Candidate lacks atomic drain commit");
        if (!handle.client.supportsMalleafBootDrain())
          throw new StorageError("unsupported_schema", "Candidate lacks boot admission gating");
        const status = await handle.quiesce({ action: "status", deadlineMs: 1000 });
        if (status.state !== "accepting")
          throw new StorageError("state_conflict", "Preflight is not accepting work");
      } finally {
        await handle.client.close();
        const registration = (await ledger.read()).registrations.preflight;
        if (registration) await stopRegistered(registration);
      }
      safeToDispose = true;
      await journal.advance(transaction.switchId, "preflight_ok");
    } catch (error) {
      safeToDispose = !(await ledger.read()).registrations.preflight;
      if (safeToDispose) await journal.advance(transaction.switchId, "aborted", String(error));
      throw error;
    } finally {
      if (safeToDispose) await scratch.dispose();
    }
  }
  async function rollback(
    transaction: SwitchTransaction,
    error: string | null = null,
    blocked = false,
  ) {
    await journal.advance(transaction.switchId, "reverting", error);
    const state = await pointer.read();
    if (!samePair(state.current, transaction.baseline))
      throw new StorageError(
        "state_conflict",
        "A committed candidate cannot be rolled back implicitly",
      );
    const candidate = (await ledger.read()).registrations.candidate;
    if (candidate) {
      // Validate all homes/identities before authorizing even this exact stop.
      const plan = await inspectRecovery({
        home,
        pointer: state,
        transaction: await transactionFor(transaction.switchId),
        ledger: await ledger.read(),
      });
      for (const registration of plan.stop) await stopRegistered(registration);
      await clearStopped("candidate");
    }
    if (state.trial) await pointer.revert(decision(transaction));
    if (!running) await startBaseline(transaction.baseline);
    if (blocked) await journal.advance(transaction.switchId, "blocked", error);
    else await journal.afterPointer(transaction.switchId, "rolled_back", pointer.read);
  }
  async function attachRecovery(
    plan: RecoveryPlan,
    transaction: SwitchTransaction | null,
    attachOnly = false,
  ) {
    if (!plan.attach) return false;
    const expected = plan.attach.instance;
    if (!expected) throw new StorageError("state_conflict", "Recovery cannot attach an intent");
    await assertAcceptanceEpoch(plan.attach.home);
    const handle = await attachRuntime({
      ...target(plan.target),
      expected,
      controllerToken: requireControllerToken(plan.attach),
    });
    running = { pair: plan.target, role: await roleOf(plan.attach), handle };
    const status = await handle.quiesce({ action: "status", deadlineMs: 1000 });
    if (status.state === "shutdown") {
      if (attachOnly)
        throw new StorageError("state_conflict", "Handoff cannot restart a frozen daemon");
      await stopRegistered(plan.attach);
      return true;
    }
    if (status.state === "draining") {
      const drainId = status.expiresAt === null ? plan.attach.bootDrainId : transaction?.drainId;
      const selected = await pointer.read();
      if (
        !drainId ||
        status.drainId !== drainId ||
        !(
          samePair(selected.current, plan.target) ||
          (selected.trial && samePair(selected.trial.pair, plan.target))
        )
      )
        throw new StorageError("state_conflict", "Another owner controls the runtime drain");
      assertOwned();
      await handle.quiesce({
        action: "end",
        drainId,
        deadlineMs: 1000,
      });
    }
    return false;
  }
  async function finishRecovery(plan: RecoveryPlan, transaction: SwitchTransaction | null) {
    if (!running) await startBaseline(plan.target);
    if (plan.action === "abort" && transaction)
      await journal.advance(transaction.switchId, "aborted");
    if (plan.action === "committed" && transaction) {
      const candidate = (await ledger.read()).registrations.candidate;
      if (candidate) await ledger.promote(candidate.token);
      if (running) running.role = "baseline";
      await journal.afterPointer(transaction.switchId, "kept", pointer.read);
    }
    // Keep intent is not a keep commit. Leave committing trials for an explicit
    // keep retry or revert instead of forcing an invalid committing -> trial.
    if (plan.action === "trial" && transaction?.step === "probing")
      await journal.afterPointer(transaction.switchId, "trial", pointer.read);
  }
  async function recover(recoveryOptions: { attachOnly?: boolean } = {}) {
    const state = await pointer.read();
    const transaction = (await journal.read()).transaction;
    const plan = await inspectRecovery({
      home,
      pointer: state,
      transaction,
      ledger: await ledger.read(),
    });
    if (
      recoveryOptions.attachOnly &&
      (!plan.attach ||
        plan.stop.length ||
        state.trial ||
        !samePair(plan.target, state.current) ||
        !["current", "committed"].includes(plan.action))
    )
      throw new StorageError(
        "state_conflict",
        "Handoff requires a registered live selected daemon; launch or recovery actions are unavailable",
      );
    // Inspection above finishes before the first stop or launch.
    for (const registration of plan.stop) await stopRegistered(registration);
    for (const role of ["preflight", "baseline", "candidate"] as const) {
      const registration = (await ledger.read()).registrations[role];
      if (registration && registration.token !== plan.attach?.token) await clearStopped(role);
    }
    if (running) {
      await running.handle.client.close();
      running = null;
    }
    const frozenTrial = await attachRecovery(plan, transaction, recoveryOptions.attachOnly);
    if (frozenTrial && state.trial && transaction) {
      await rollback(transaction);
      return result();
    }
    if (plan.action === "rollback" && transaction) await rollback(transaction);
    else await finishRecovery(plan, transaction);
    return result();
  }
  async function result() {
    return {
      pointer: await pointer.read(),
      transaction: (await journal.read()).transaction,
      runtime: running?.handle ?? null,
    };
  }
  async function activate(request: ActivationRequest) {
    const state = await pointer.read();
    const previous = (await journal.read()).transaction;
    const baseline = previous?.switchId === request.switchId ? previous.baseline : state.current;
    await journal.begin({ ...request, baseline }, state);
    const transaction = await transactionFor(request.switchId);
    if (terminalSwitch(transaction.step) || transaction.step === "trial") return result();
    if (!["requested", "drain_timeout"].includes(transaction.step)) return recover();
    const current = requireRunning(baseline);
    if (!current.handle.client.supportsMalleafQuiesceCommit())
      throw new StorageError("unsupported_schema", "Baseline lacks atomic drain commit");
    if (transaction.step === "requested") await preflight(transaction);
    await journal.advance(request.switchId, "draining");
    if (
      !(await drainAndCommit({
        runtime: current.handle,
        drainId: transaction.drainId,
        deadlineMs,
        assertOwned,
      }))
    ) {
      await journal.advance(request.switchId, "drain_timeout");
      return result();
    }
    // The stop intent is durable before the signal. A crash after commit but
    // before this write is recovered by inspecting the frozen runtime status.
    await journal.advance(request.switchId, "stopping");
    await stopRunning(baseline);
    await journal.advance(request.switchId, "stopped");
    try {
      await journal.advance(request.switchId, "cloning");
      const plan = await planEpochCopy({
        sourceHome: epochHome(home, transaction.copySource),
        dataRoot: path.join(home, "data"),
        dataId: transaction.candidate.dataId,
        buildId: transaction.candidate.buildId,
        shared: options.shared,
        policy: options.policy,
      });
      if (plan.blockers.length) {
        await rollback(transaction, JSON.stringify(plan.blockers), true);
        return result();
      }
      await executeEpochCopy(plan);
      await journal.advance(request.switchId, "cloned");
      await journal.advance(request.switchId, "starting");
      const bootDrainId = randomUUID();
      const handle = await launch(
        "candidate",
        transaction.candidate,
        epochHome(home, transaction.candidate),
        options.environment,
        bootDrainId,
      );
      running = { pair: transaction.candidate, role: "candidate", handle };
      await journal.advance(request.switchId, "probing");
      const status = await handle.quiesce({ action: "status", deadlineMs: 1000 });
      if (
        !handle.client.supportsMalleafBootDrain() ||
        status.state !== "draining" ||
        status.expiresAt !== null ||
        status.drainId !== bootDrainId ||
        status.terminals ||
        status.scripts ||
        hasPendingDrainWork(status)
      )
        throw new StorageError("state_conflict", "Isolated candidate probe is not quiescent");
      await journal.afterPointer(request.switchId, "trial", () =>
        pointer.beginTrial({ pair: transaction.candidate, ...decision(transaction) }),
      );
      assertOwned();
      await handle.quiesce({ action: "end", drainId: bootDrainId });
    } catch (error) {
      if (!(await recoverFailedActivation(transaction, error))) throw error;
    }
    return result();
  }
  async function recoverFailedActivation(transaction: SwitchTransaction, error: unknown) {
    try {
      // Pointer is authoritative even when the journal write itself failed.
      const selected = await pointer.read();
      if (selected.trial || !samePair(selected.current, transaction.baseline)) return false;
      const latest = await transactionFor(transaction.switchId);
      if (latest.step === "trial" || latest.step === "kept" || latest.step === "rolled_back")
        return false;
      await journal.advance(transaction.switchId, latest.step, String(error));
      await inspectRecovery({
        home,
        pointer: selected,
        transaction: latest,
        ledger: await ledger.read(),
      });
      await rollback(transaction, String(error));
      return true;
    } catch (recoveryError) {
      // AggregateError's cause options are its third argument; both failures
      // are retained in errors as well.
      // oxlint-disable-next-line preserve-caught-error
      throw new AggregateError(
        [error, recoveryError],
        `Activation failed and recovery could not be confirmed: ${String(error)}; ${String(recoveryError)}`,
        { cause: recoveryError },
      );
    }
  }
  async function keep(switchId: string) {
    const transaction = await transactionFor(switchId);
    const state = await pointer.read();
    if (samePair(state.current, transaction.candidate) && !state.trial) return recover();
    const current = requireRunning(transaction.candidate);
    const live = await readDaemonInstance(epochHome(home, transaction.candidate));
    if (
      !live ||
      !isSameDaemonInstance(live, current.handle.instance) ||
      (await current.handle.quiesce({ action: "status", deadlineMs: 1000 })).state !== "accepting"
    )
      throw new StorageError("state_conflict", "Candidate is not a live accepting trial");
    await journal.advance(switchId, "committing");
    // Nothing after this call is allowed to roll back a successful pointer keep.
    await journal.afterPointer(switchId, "kept", () => pointer.keep(decision(transaction)));
    const candidate = (await ledger.read()).registrations.candidate;
    if (!candidate) throw new StorageError("state_conflict", "Kept candidate has no registration");
    await ledger.promote(candidate.token);
    if (running) running.role = "baseline";
    return result();
  }
  async function commitTrialStop(transaction: SwitchTransaction) {
    const current = requireRunning(transaction.candidate);
    const status = await current.handle.quiesce({
      action: "status",
      deadlineMs: 1000,
    });
    if (status.state === "shutdown") return true;
    if (status.state === "draining" && status.expiresAt === null) {
      const registration = (await ledger.read()).registrations[current.role];
      if (!registration?.bootDrainId || registration.bootDrainId !== status.drainId)
        throw new StorageError("state_conflict", "Trial boot gate has an unknown owner");
      assertOwned();
      // Revert must not require opening an unpublished-work gate, including when
      // its durable release previously failed. Commit checks the barriers itself.
      await current.handle.quiesce({
        action: "commit",
        drainId: registration.bootDrainId,
        deadlineMs: 1000,
      });
      return true;
    }
    return drainAndCommit({
      runtime: current.handle,
      drainId: transaction.drainId,
      deadlineMs,
      assertOwned,
    });
  }
  async function revert(switchId: string) {
    const transaction = await transactionFor(switchId);
    if (transaction.step === "rolled_back") return result();
    const state = await pointer.read();
    if (state.trial?.switchId !== switchId)
      throw new StorageError("state_conflict", "No matching trial can be reverted");
    if (!(await commitTrialStop(transaction))) return { ...(await result()), paused: true };
    await journal.advance(switchId, "reverting");
    await stopRunning(transaction.candidate);
    await rollback(transaction);
    return result();
  }
  return {
    recover: (recoveryOptions?: { attachOnly?: boolean }) =>
      serialize(() => recover(recoveryOptions)),
    activate: (request: ActivationRequest) => serialize(() => activate(request)),
    keep: (switchId: string) => serialize(() => keep(switchId)),
    revert: (switchId: string) => serialize(() => revert(switchId)),
    abort: (switchId: string) =>
      serialize(async () => {
        const transaction = await transactionFor(switchId);
        if (!["requested", "preflight_ok", "drain_timeout"].includes(transaction.step))
          throw new StorageError(
            "state_conflict",
            "Only a safely paused pre-stop switch can be aborted",
          );
        await journal.advance(switchId, "aborted");
        return result();
      }),
    // Closing a controller connection deliberately leaves its registered daemon
    // alive so another lease holder can exercise recovery after a crash.
    disconnect: () =>
      serialize(async () => {
        await running?.handle.client.close();
        running = null;
      }),
  };
}

// Until boot admission covers persisted automation, refuse those inputs rather
// than letting a purported smoke test execute schedules or real providers.
async function assertAcceptanceEpoch(home: string) {
  const disabled = z.object({ enabled: z.literal(false) });
  const config = z
    .object({
      pluginsEnabled: z.literal(false),
      daemon: z.object({ relay: disabled, enableTerminalAgentHooks: z.literal(false) }),
      agents: z.object({ providers: z.record(z.string(), z.object({ enabled: z.boolean() })) }),
      features: z.object({ dictation: disabled, voiceMode: disabled, webUi: disabled }),
    })
    .parse(await readJson(path.join(home, "config.json")));
  if (
    BUILTIN_PROVIDER_IDS.some((id) => config.agents.providers[id]?.enabled !== false) ||
    Object.entries(config.agents.providers).some(
      ([id, provider]) => provider.enabled && id !== "mock",
    )
  )
    throw new StorageError("unsafe_path", "Activation acceptance only permits the mock provider");
  for (const name of ["hub-relationship.json", "push-tokens.json"])
    if (await exists(path.join(home, name)))
      throw new StorageError(
        "unsafe_path",
        `Activation acceptance refuses external state: ${name}`,
      );
  for (const name of ["schedules", "managed-processes"])
    if ((await exists(path.join(home, name))) && (await readdir(path.join(home, name))).length)
      throw new StorageError(
        "unsafe_path",
        `Activation acceptance refuses persisted automation: ${name}`,
      );
}
