import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { assertStoragePath } from "../isolation.js";
import { containedRealPath, exists, StorageError, writeJsonAtomic } from "../storage.js";

export const documentSchema = z.looseObject({
  schemaVersion: z.number().int().positive(),
  minReaderVersion: z.number().int().positive(),
  minWriterVersion: z.number().int().positive(),
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  updatedAt: z.string().datetime(),
});
type DocumentHeader = z.infer<typeof documentSchema>;

export function initialDocument() {
  return {
    schemaVersion: 1,
    minReaderVersion: 1,
    minWriterVersion: 1,
    seq: 0,
    updatedAt: new Date().toISOString(),
  };
}

interface DocumentOptions<T extends DocumentHeader> {
  home: string;
  name: "switch.json" | "instances.json";
  schema: z.ZodType<T>;
  initial: T;
  assertOwned(): void;
}

// Journal and ledger share the pointer's write discipline, but never its commit
// authority. A failed filesystem commit requires reopening under a fresh owner.
export async function openOwnedDocument<T extends DocumentHeader>(options: DocumentOptions<T>) {
  assertStoragePath(options.home);
  options.assertOwned();
  const root = await realpath(options.home);
  const runner = path.join(root, "runner");
  const filename = path.join(runner, options.name);
  await mkdir(runner, { recursive: true });
  let poisoned = false;
  let accepting = true;
  let queue: Promise<void> = Promise.resolve();

  function assertOwned() {
    if (poisoned) throw new StorageError("state_conflict", `State writer is poisoned: ${filename}`);
    try {
      options.assertOwned();
    } catch (error) {
      poisoned = true;
      throw error;
    }
  }

  async function checkPath() {
    await containedRealPath(root, runner);
    if (!(await lstat(runner)).isDirectory())
      throw new StorageError("unsafe_path", "Runner state requires a physical directory");
    if (await exists(filename)) {
      await containedRealPath(root, filename);
      if (!(await lstat(filename)).isFile())
        throw new StorageError("unsafe_path", `Runner state must be a regular file: ${filename}`);
    }
  }

  function parse(value: unknown): T {
    try {
      const header = documentSchema.parse(value);
      if (
        header.minReaderVersion > 1 ||
        header.minReaderVersion > header.schemaVersion ||
        header.minWriterVersion > header.schemaVersion
      )
        throw new StorageError("unsupported_schema", `Unsupported runner state: ${filename}`);
      return options.schema.parse(value);
    } catch (error) {
      if (error instanceof z.ZodError)
        throw new StorageError("invalid_state", `Malformed runner state: ${filename}`);
      throw error;
    }
  }

  async function readDocument() {
    await checkPath();
    const text = await readFile(filename, "utf8");
    try {
      return {
        value: parse(JSON.parse(text)),
        digest: createHash("sha256").update(text).digest("hex"),
      };
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new StorageError("invalid_state", `Invalid JSON in runner state: ${filename}`);
      throw error;
    }
  }

  await checkPath();
  if (!(await exists(filename))) {
    await writeJsonAtomic({
      filename,
      mode: "publish",
      value: parse(options.initial),
      beforeCommit: assertOwned,
    });
  }
  let observed = await readDocument();

  function enqueue<R>(operation: () => Promise<R>): Promise<R> {
    if (!accepting)
      return Promise.reject(
        new StorageError("store_sealed", `State writer is sealed: ${filename}`),
      );
    const result = queue.then(operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function reread() {
    assertOwned();
    const latest = await readDocument();
    if (latest.digest !== observed.digest || latest.value.seq !== observed.value.seq) {
      poisoned = true;
      throw new StorageError(
        "state_conflict",
        `Runner state changed outside its writer: ${filename}`,
      );
    }
    return latest.value;
  }

  return {
    read: () => enqueue(async () => structuredClone(await reread())),
    update(mutate: (current: T) => T | Promise<T>) {
      return enqueue(async () => {
        const current = await reread();
        if (current.minWriterVersion > 1)
          throw new StorageError(
            "unsupported_schema",
            `Runner state requires a newer writer: ${filename}`,
          );
        const next = parse({
          ...(await mutate(current)),
          seq: current.seq + 1,
          updatedAt: new Date().toISOString(),
        });
        try {
          // A pointer operation may have awaited filesystem I/O inside mutate.
          // Recheck the journal before publishing its subsequent fact.
          await reread();
          await writeJsonAtomic({ filename, value: next, beforeCommit: assertOwned });
          observed = await readDocument();
          if (JSON.stringify(observed.value) !== JSON.stringify(next))
            throw new StorageError(
              "state_conflict",
              `Runner state changed during publication: ${filename}`,
            );
        } catch (error) {
          poisoned = true;
          throw error;
        }
        return structuredClone(observed.value);
      });
    },
    async seal() {
      accepting = false;
      await queue;
    },
  };
}
