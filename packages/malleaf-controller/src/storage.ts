import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

export type StorageErrorCode =
  | "unsafe_path"
  | "artifact_changed"
  | "incomplete_artifact"
  | "identity_conflict"
  | "epoch_blocked"
  | "state_conflict"
  | "publication_failed"
  | "unsupported_schema"
  | "store_sealed"
  | "lease_lost"
  | "lease_held"
  | "port_occupied"
  | "invalid_state";

export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

export function relativePath(value: string): string {
  const hasControlCharacter = [...value].some((character) => character.charCodeAt(0) < 32);
  const invalid =
    !value ||
    /[\\:]/.test(value) ||
    hasControlCharacter ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..");
  if (invalid) throw new StorageError("unsafe_path", `Expected a portable relative path: ${value}`);
  return value;
}

export function isWithin(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export async function containedRealPath(root: string, filename: string): Promise<string> {
  const resolved = await realpath(filename);
  if (!isWithin(root, resolved))
    throw new StorageError("unsafe_path", `Path escapes ${root}: ${filename}`);
  return resolved;
}

export async function prospectiveRealPath(filename: string): Promise<string> {
  const absolute = path.resolve(filename);
  if (await exists(absolute)) return realpath(absolute);
  const parent = path.dirname(absolute);
  if (parent === absolute) return absolute;
  return path.join(await prospectiveRealPath(parent), path.basename(absolute));
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function exists(filename: string): Promise<boolean> {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export async function hashFile(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

interface ContainedCopy {
  root: string;
  source: string;
  destination: string;
}

export async function copyContainedFile({
  root,
  source,
  destination,
}: ContainedCopy): Promise<void> {
  const resolvedSource = await containedRealPath(root, source);
  const before = await lstat(resolvedSource);
  if (!before.isFile())
    throw new StorageError("unsafe_path", `Expected a regular source file: ${source}`);
  const input = await open(resolvedSource, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await input.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || !opened.isFile()) {
      throw new StorageError("state_conflict", `Source changed before copying: ${source}`);
    }
    const output = createWriteStream(destination, { flags: "wx", mode: before.mode & 0o777 });
    await pipeline(input.createReadStream({ autoClose: false }), output);
    await containedRealPath(root, source);
  } finally {
    await input.close();
  }
}

export async function readJson(filename: string): Promise<unknown> {
  return JSON.parse(await readFile(filename, "utf8"));
}

interface JsonCommit {
  filename: string;
  value: unknown;
  mode?: "replace" | "publish";
  beforeCommit?: () => void;
}

export async function writeJsonAtomic({
  filename,
  value,
  mode = "replace",
  beforeCommit,
}: JsonCommit): Promise<void> {
  const directory = path.dirname(filename);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(filename)}.${randomUUID()}.partial`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    beforeCommit?.();
    if (mode === "publish") {
      try {
        await link(temporary, filename);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST")
          throw new StorageError("state_conflict", `State already exists: ${filename}`);
        throw new StorageError("publication_failed", `Cannot publish ${filename}: ${error}`);
      }
    } else {
      await rename(temporary, filename);
    }
    if (process.platform !== "win32") {
      const parent = await open(directory, constants.O_RDONLY);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
