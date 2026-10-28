import { z } from "zod";
import { StorageError } from "../storage.js";
import { documentSchema, initialDocument, openOwnedDocument } from "./document.js";
import { runtimePairSchema, type RuntimePair, type RuntimePointer } from "./pointer.js";

const stepSchema = z.enum([
  "requested",
  "preflight",
  "preflight_ok",
  "draining",
  "drain_timeout",
  "stopping",
  "stopped",
  "cloning",
  "cloned",
  "starting",
  "probing",
  "trial",
  "committing",
  "kept",
  "reverting",
  "rolled_back",
  "blocked",
  "aborted",
]);
export type SwitchStep = z.infer<typeof stepSchema>;
type PointerFact = "trial" | "kept" | "rolled_back";
const transactionSchema = z.looseObject({
  switchId: z.string().uuid(),
  switchToken: z.string().uuid(),
  drainId: z.string().uuid(),
  baseline: runtimePairSchema,
  copySource: runtimePairSchema,
  candidate: runtimePairSchema,
  step: stepSchema,
  pointerSeq: z.number().int().nonnegative(),
  error: z.string().nullable(),
});
export type SwitchTransaction = z.infer<typeof transactionSchema>;
const journalSchema = documentSchema.extend({ transaction: transactionSchema.nullable() });
export type SwitchJournalState = z.infer<typeof journalSchema>;
export type SwitchRequest = Pick<
  SwitchTransaction,
  "switchId" | "switchToken" | "drainId" | "baseline" | "copySource" | "candidate"
>;

const transitions: Record<SwitchStep, readonly SwitchStep[]> = {
  requested: ["preflight", "aborted"],
  preflight: ["preflight_ok", "aborted"],
  preflight_ok: ["draining", "aborted"],
  draining: ["drain_timeout", "stopping", "aborted"],
  drain_timeout: ["draining", "aborted"],
  stopping: ["stopped", "reverting"],
  stopped: ["cloning", "reverting"],
  cloning: ["cloned", "reverting"],
  cloned: ["starting", "reverting"],
  starting: ["probing", "reverting"],
  probing: ["trial", "reverting"],
  trial: ["committing", "reverting"],
  committing: ["kept", "reverting"],
  reverting: ["rolled_back", "blocked"],
  kept: [],
  rolled_back: [],
  blocked: [],
  aborted: [],
};

export function samePair(left: RuntimePair, right: RuntimePair): boolean {
  return left.buildId === right.buildId && left.dataId === right.dataId;
}
export function terminalSwitch(step: SwitchStep): boolean {
  return ["kept", "rolled_back", "blocked", "aborted"].includes(step);
}
function requireTransaction(state: SwitchJournalState, switchId: string) {
  if (!state.transaction || state.transaction.switchId !== switchId)
    throw new StorageError("state_conflict", "Switch identity no longer matches the journal");
  return state.transaction;
}
function assertTransition(from: SwitchStep, to: SwitchStep) {
  if (from !== to && !transitions[from].includes(to))
    throw new StorageError("state_conflict", `Invalid switch transition: ${from} -> ${to}`);
}

export async function openSwitchJournal(options: { home: string; assertOwned(): void }) {
  const store = await openOwnedDocument({
    ...options,
    name: "switch.json",
    schema: journalSchema,
    initial: { ...initialDocument(), transaction: null },
  });
  return {
    read: store.read,
    seal: store.seal,
    begin(request: SwitchRequest, pointer: RuntimePointer) {
      const transaction = transactionSchema.parse({
        ...request,
        step: "requested",
        pointerSeq: pointer.seq,
        error: null,
      });
      return store.update((state) => {
        if (state.transaction?.switchId === transaction.switchId) {
          const existing = state.transaction;
          if (
            !samePair(existing.baseline, transaction.baseline) ||
            !samePair(existing.copySource, transaction.copySource) ||
            !samePair(existing.candidate, transaction.candidate) ||
            existing.switchToken !== transaction.switchToken ||
            existing.drainId !== transaction.drainId
          )
            throw new StorageError(
              "state_conflict",
              "Repeated switch identity has different arguments",
            );
          return state;
        }
        if (state.transaction && !terminalSwitch(state.transaction.step))
          throw new StorageError(
            "state_conflict",
            "An unfinished switch must be recovered or aborted first",
          );
        if (
          pointer.trial ||
          !samePair(pointer.current, transaction.baseline) ||
          (!samePair(transaction.copySource, pointer.current) &&
            (!pointer.previous || !samePair(transaction.copySource, pointer.previous))) ||
          [pointer.current.dataId, pointer.previous?.dataId].includes(transaction.candidate.dataId)
        )
          throw new StorageError(
            "state_conflict",
            "Switch must clone a retained pair into a new epoch",
          );
        return { ...state, transaction };
      });
    },
    advance(switchId: string, step: Exclude<SwitchStep, PointerFact>, error: string | null = null) {
      if (["trial", "kept", "rolled_back"].includes(step))
        return Promise.reject(
          new StorageError("state_conflict", "Pointer facts require a pointer operation"),
        );
      return store.update((state) => {
        const transaction = requireTransaction(state, switchId);
        assertTransition(transaction.step, step);
        return { ...state, transaction: { ...transaction, step, error } };
      });
    },
    // Read pointer truth after its operation, never write a successful fact first.
    async afterPointer(
      switchId: string,
      step: PointerFact,
      operation: () => Promise<RuntimePointer>,
    ) {
      return store.update(async (state) => {
        const transaction = requireTransaction(state, switchId);
        assertTransition(transaction.step, step);
        const pointer = await operation();
        const matchesTrial =
          pointer.trial?.switchId === switchId &&
          pointer.trial.candidateToken === transaction.switchToken &&
          samePair(pointer.trial.pair, transaction.candidate) &&
          samePair(pointer.current, transaction.baseline);
        const matchesKept =
          pointer.trial === null && samePair(pointer.current, transaction.candidate);
        const matchesRevert =
          pointer.trial === null && samePair(pointer.current, transaction.baseline);
        if (
          pointer.seq < transaction.pointerSeq ||
          (step === "trial" && !matchesTrial) ||
          (step === "kept" && !matchesKept) ||
          (step === "rolled_back" && !matchesRevert)
        )
          throw new StorageError(
            "state_conflict",
            "Pointer does not establish the requested switch fact",
          );
        return { ...state, transaction: { ...transaction, step, pointerSeq: pointer.seq } };
      });
    },
  };
}
