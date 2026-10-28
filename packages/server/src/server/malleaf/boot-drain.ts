import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { MalleafDrainIdSchema } from "@getpaseo/protocol/malleaf/quiesce";
import { assertMalleafHomeIsolated, canonicalMalleafPath } from "./home.js";

const markerSchema = z.object({
  schemaVersion: z.literal(1),
  drainId: MalleafDrainIdSchema,
  releasedAt: z.string().datetime(),
});

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function markerPath(home: string): Promise<string> {
  assertMalleafHomeIsolated(home);
  const directory = path.join(canonicalMalleafPath(home), "runtime");
  try {
    if (!(await lstat(directory)).isDirectory())
      throw new Error("Boot drain runtime must be a real directory");
  } catch (error) {
    if (!missing(error)) throw error;
  }
  return path.join(directory, "boot-drain-released.json");
}

export async function readBootDrainMarker(
  home: string,
  onInvalid: (error: unknown) => void,
): Promise<string | null> {
  const filename = await markerPath(home);
  let contents: string;
  try {
    if (!(await lstat(filename)).isFile())
      throw new Error("Boot drain marker must be a regular file");
    contents = await readFile(filename, "utf8");
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  try {
    return markerSchema.parse(JSON.parse(contents)).drainId;
  } catch (error) {
    onInvalid(error);
    return null; // Corrupt evidence must never open admission.
  }
}

export async function publishBootDrainMarker(home: string, drainId: string): Promise<void> {
  MalleafDrainIdSchema.parse(drainId);
  const filename = await markerPath(home);
  const directory = path.dirname(filename);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await markerPath(home);
  const temporary = `${filename}.${randomUUID()}.partial`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(
        JSON.stringify({ schemaVersion: 1, drainId, releasedAt: new Date().toISOString() }),
      );
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      // Publish once: another token or a corrupt marker requires diagnosis.
      // A retry after a successful publication is harmless for the same token.
      await link(temporary, filename);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const recorded = await readBootDrainMarker(home, (invalid) => {
        throw invalid;
      });
      if (recorded !== drainId)
        throw new Error("Boot drain release belongs to another token", { cause: error });
    }
    if (process.platform !== "win32") {
      const parent = await open(directory, "r");
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

export async function restoreBootDrain(options: {
  home: string;
  drainId: string | undefined;
  adopt(drainId: string): void;
  onInvalid(error: unknown): void;
}): Promise<void> {
  if (!options.drainId) return;
  MalleafDrainIdSchema.parse(options.drainId);
  if ((await readBootDrainMarker(options.home, options.onInvalid)) !== options.drainId)
    options.adopt(options.drainId);
}
