import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { assertStoragePath } from "../isolation.js";
import { verifySlot } from "../slot/materialize.js";
import {
  containedRealPath,
  exists,
  readJson,
  relativePath,
  StorageError,
  writeJsonAtomic,
} from "../storage.js";

const readerVersion = 1;
const writerVersion = 1;
const dataIdSchema = z.string().refine((value) => {
  try {
    return (
      relativePath(value) === value &&
      !value.includes("/") &&
      !value.startsWith(".") &&
      !value.endsWith(".partial")
    );
  } catch {
    return false;
  }
}, "Expected a completed epoch name");

export const runtimePairSchema = z.looseObject({
  buildId: z.string().regex(/^[a-f0-9]{64}$/),
  dataId: dataIdSchema,
});
export type RuntimePair = z.infer<typeof runtimePairSchema>;

const compatibilitySchema = z.looseObject({
  schemaVersion: z.number().int().positive(),
  minReaderVersion: z.number().int().positive(),
  minWriterVersion: z.number().int().positive(),
});
const trialSchema = z.looseObject({
  pair: runtimePairSchema,
  switchId: z.string().min(1),
  candidateToken: z.string().min(1),
  since: z.string().datetime(),
});
const pointerSchema = compatibilitySchema.extend({
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  current: runtimePairSchema,
  previous: runtimePairSchema.nullable(),
  trial: trialSchema.nullable(),
  updatedAt: z.string().datetime(),
  writer: z.looseObject({ pid: z.number().int().positive(), token: z.string().min(1) }),
});
export type RuntimePointer = z.infer<typeof pointerSchema>;
const trialRequestSchema = trialSchema.omit({ since: true });
type TrialRequest = z.infer<typeof trialRequestSchema>;
const trialDecisionSchema = trialSchema.pick({ switchId: true, candidateToken: true });
type TrialDecision = z.infer<typeof trialDecisionSchema>;

interface PointerUpdate {
  mutate: (pointer: RuntimePointer) => RuntimePointer;
  verifyReferences: boolean;
}

interface PointerOptions {
  home: string;
  writerToken: string;
  assertOwned: () => void;
  initial?: RuntimePair;
  protectedPaths?: readonly string[];
}

function parsePointer(value: unknown): RuntimePointer {
  const compatibility = compatibilitySchema.parse(value);
  if (
    compatibility.minReaderVersion > readerVersion ||
    compatibility.minReaderVersion > compatibility.schemaVersion ||
    compatibility.minWriterVersion > compatibility.schemaVersion
  )
    throw new StorageError(
      "unsupported_schema",
      "This runtime cannot read the selected pointer schema",
    );
  const pointer = pointerSchema.parse(value);
  if (
    pointer.previous?.dataId === pointer.current.dataId ||
    pointer.trial?.pair.dataId === pointer.current.dataId ||
    (pointer.previous !== null && pointer.trial?.pair.dataId === pointer.previous.dataId)
  )
    throw new StorageError(
      "state_conflict",
      "Current, previous and trial must use separate data epochs",
    );
  return pointer;
}

async function verifyReferences(home: string, pointer: RuntimePointer): Promise<void> {
  const root = await realpath(home);
  for (const pair of [pointer.current, pointer.previous, pointer.trial?.pair]) {
    if (!pair) continue;
    const slotDirectory = path.join(home, "versions", pair.buildId);
    const epochDirectory = path.join(home, "data", pair.dataId);
    for (const directory of [slotDirectory, epochDirectory]) {
      await containedRealPath(root, directory);
      if (!(await lstat(directory)).isDirectory())
        throw new StorageError("unsafe_path", "Runtime pairs must refer to physical directories");
    }
    await verifySlot({
      directory: slotDirectory,
      expectedBuildId: pair.buildId,
      mode: "entries",
    });
    const epochFile = path.join(epochDirectory, "epoch.json");
    if (!(await lstat(epochFile)).isFile())
      throw new StorageError("incomplete_artifact", "Epoch manifest must be a regular file");
    const epoch = z
      .object({ schemaVersion: z.literal(1), dataId: dataIdSchema, buildIdAtCopy: z.string() })
      .parse(await readJson(epochFile));
    if (epoch.dataId !== pair.dataId || epoch.buildIdAtCopy !== pair.buildId)
      throw new StorageError(
        "identity_conflict",
        `Epoch does not belong to the selected build: ${pair.dataId}`,
      );
  }
}

async function checkPointerPath(home: string, filename: string): Promise<void> {
  const root = await realpath(home);
  const runner = path.dirname(filename);
  await containedRealPath(root, runner);
  if (!(await lstat(runner)).isDirectory())
    throw new StorageError("unsafe_path", "Runner state must use a physical directory");
  if (await exists(filename)) {
    await containedRealPath(root, filename);
    if (!(await lstat(filename)).isFile())
      throw new StorageError("unsafe_path", "Pointer must be a regular file");
  }
}

async function readPointer(home: string, filename: string) {
  await checkPointerPath(home, filename);
  const text = await readFile(filename, "utf8");
  try {
    return {
      pointer: parsePointer(JSON.parse(text)),
      digest: createHash("sha256").update(text).digest("hex"),
    };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError)
      throw new StorageError("invalid_state", `Invalid runtime pointer: ${filename}`);
    throw error;
  }
}

export async function openPointerStore(options: PointerOptions) {
  assertStoragePath(options.home, options.protectedPaths);
  const filename = path.join(options.home, "runner/current.json");
  assertStoragePath(path.dirname(filename), options.protectedPaths);
  const writer = { pid: process.pid, token: options.writerToken };
  options.assertOwned();
  await mkdir(path.dirname(filename), { recursive: true });
  await checkPointerPath(options.home, filename);
  if (!(await exists(filename))) {
    if (!options.initial)
      throw new StorageError("state_conflict", "Runtime has not been initialized");
    const initial = parsePointer({
      schemaVersion: readerVersion,
      minReaderVersion: readerVersion,
      minWriterVersion: writerVersion,
      seq: 0,
      current: options.initial,
      previous: null,
      trial: null,
      updatedAt: new Date().toISOString(),
      writer,
    });
    await verifyReferences(options.home, initial);
    await writeJsonAtomic({
      filename,
      value: initial,
      mode: "publish",
      beforeCommit: options.assertOwned,
    });
  }
  let observed = await readPointer(options.home, filename);
  let queue: Promise<void> = Promise.resolve();
  let accepting = true;
  let poisoned = false;

  function assertOwned(): void {
    if (poisoned)
      throw new StorageError(
        "state_conflict",
        "Pointer writer lost its state; restart the controller",
      );
    try {
      options.assertOwned();
    } catch (error) {
      poisoned = true;
      throw error;
    }
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (!accepting)
      return Promise.reject(new StorageError("store_sealed", "Pointer writer is sealed"));
    const result = queue.then(operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function reread(): Promise<RuntimePointer> {
    assertOwned();
    const latest = await readPointer(options.home, filename);
    if (latest.pointer.seq !== observed.pointer.seq || latest.digest !== observed.digest) {
      poisoned = true;
      throw new StorageError("state_conflict", "Pointer was changed by another writer");
    }
    return latest.pointer;
  }

  function update(change: PointerUpdate): Promise<RuntimePointer> {
    return enqueue(async () => {
      const current = await reread();
      if (current.minWriterVersion > writerVersion)
        throw new StorageError(
          "unsupported_schema",
          "This runtime cannot write the selected pointer schema",
        );
      const next = parsePointer({
        ...change.mutate(current),
        seq: current.seq + 1,
        writer,
        updatedAt: new Date().toISOString(),
      });
      if (change.verifyReferences) await verifyReferences(options.home, next);
      try {
        await writeJsonAtomic({ filename, value: next, beforeCommit: assertOwned });
        observed = await readPointer(options.home, filename);
        if (JSON.stringify(observed.pointer) !== JSON.stringify(next))
          throw new StorageError("state_conflict", "Pointer changed while committing");
      } catch (error) {
        // A filesystem failure can occur after rename; never retry from cached state.
        poisoned = true;
        throw error;
      }
      return structuredClone(observed.pointer);
    });
  }

  function requireTrial(pointer: RuntimePointer, decision: TrialDecision) {
    if (
      !pointer.trial ||
      pointer.trial.switchId !== decision.switchId ||
      pointer.trial.candidateToken !== decision.candidateToken
    )
      throw new StorageError("state_conflict", "The requested trial is no longer selected");
    return pointer.trial;
  }

  return {
    read: () => enqueue(reread),
    beginTrial(request: TrialRequest) {
      const trial = trialSchema.parse({ ...request, since: new Date().toISOString() });
      return update({
        verifyReferences: true,
        mutate(pointer) {
          if (pointer.trial)
            throw new StorageError("state_conflict", "A trial is already selected");
          return { ...pointer, trial };
        },
      });
    },
    keep(decision: TrialDecision) {
      return update({
        verifyReferences: true,
        mutate: (pointer) => ({
          ...pointer,
          current: requireTrial(pointer, decision).pair,
          previous: pointer.current,
          trial: null,
        }),
      });
    },
    revert(decision: TrialDecision) {
      return update({
        verifyReferences: false,
        mutate(pointer) {
          requireTrial(pointer, decision);
          return { ...pointer, trial: null };
        },
      });
    },
    async seal() {
      accepting = false;
      await queue;
    },
  };
}
