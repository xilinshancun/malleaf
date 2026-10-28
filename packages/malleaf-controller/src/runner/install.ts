import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { containedRealPath, exists, readJson, StorageError, writeJsonAtomic } from "../storage.js";
import { verifySlot } from "../slot/materialize.js";
import { acquireControlLease } from "./lease.js";
import { inspectPointer, runtimePairSchema } from "./pointer.js";
import { readRunnerConfiguration } from "./initialize.js";

const installationSchema = z.looseObject({
  schemaVersion: z.literal(1),
  sourceBuildId: runtimePairSchema.shape.buildId,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  installedAt: z.string().datetime(),
});
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function publishEntry(filename: string, bytes: Buffer, assertOwned: () => void) {
  const temporary = `${filename}.${randomUUID()}.partial`;
  try {
    const file = await open(temporary, "wx", 0o444);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    assertOwned();
    await link(temporary, filename);
    if (process.platform !== "win32") {
      const directory = await open(path.dirname(filename), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

// Installation is deliberately separate from init: before runner.json elects a
// port, competing initializers do not yet hold the same home-wide lease.
export async function installStableRunner(options: { home: string; sourceBuildId?: string }) {
  const home = await realpath(options.home);
  if (
    !(await exists(path.join(home, "runner/runner.json"))) ||
    !(await exists(path.join(home, "runner/current.json")))
  )
    throw new StorageError(
      "invalid_state",
      "Initialize the runtime before installing its stable runner",
    );
  const config = await readRunnerConfiguration(home);
  const selected = await inspectPointer(home);
  if (config.minWriterVersion > 1 || selected.minWriterVersion > 1)
    throw new StorageError(
      "unsupported_schema",
      "Stable installation requires a compatible runtime writer",
    );
  const sourceBuildId = options.sourceBuildId ?? selected.current.buildId;
  if (![selected.current.buildId, selected.previous?.buildId].includes(sourceBuildId))
    throw new StorageError("state_conflict", "Stable runner source must be current or previous");
  const lease = await acquireControlLease({
    home,
    port: config.controlPort,
    buildId: sourceBuildId,
    role: "init",
  });
  try {
    if (
      JSON.stringify(await readRunnerConfiguration(home)) !== JSON.stringify(config) ||
      JSON.stringify(await inspectPointer(home)) !== JSON.stringify(selected)
    )
      throw new StorageError(
        "state_conflict",
        "Runtime selection changed while installing stable runner",
      );
    return await installOwned(home, sourceBuildId, lease.assertOwned);
  } finally {
    await lease.release({ seal: async () => {} });
  }
}

async function installOwned(home: string, sourceBuildId: string, assertOwned: () => void) {
  const slot = path.join(home, "versions", sourceBuildId);
  const manifest = await verifySlot({
    directory: slot,
    expectedBuildId: sourceBuildId,
    mode: "entries",
  });
  const entry = manifest.entries.runner;
  if (!entry)
    throw new StorageError("incomplete_artifact", "Selected slot has no stable runner entry");
  const source = await containedRealPath(slot, path.join(slot, entry));
  const bytes = await readFile(source);
  const sha256 = hash(bytes);
  const record = manifest.files.find((file) => file.kind === "file" && file.path === entry);
  if (!record || record.kind !== "file" || record.sha256 !== sha256)
    throw new StorageError(
      "identity_conflict",
      "Stable runner changed after artifact verification",
    );
  const directory = path.join(home, "runner/stable");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory())
    throw new StorageError("unsafe_path", "Stable runner directory must be physical");
  await containedRealPath(home, directory);
  const filename = path.join(directory, "runner.cjs");
  const sidecar = path.join(directory, "runner.json");
  const present = await exists(filename);
  const recorded = await exists(sidecar);
  if (recorded && !present)
    throw new StorageError("invalid_state", "Stable runner metadata has no entry file");
  if (present) {
    if (!(await lstat(filename)).isFile() || hash(await readFile(filename)) !== sha256)
      throw new StorageError(
        "state_conflict",
        "Stable runner replacement requires an explicit handoff",
      );
    if (recorded) {
      if (!(await lstat(sidecar)).isFile())
        throw new StorageError("unsafe_path", "Stable runner metadata must be a regular file");
      let value: unknown;
      try {
        value = await readJson(sidecar);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        const invalid = new StorageError(
          "invalid_state",
          "Stable runner metadata is not valid JSON",
        );
        invalid.cause = error;
        throw invalid;
      }
      const parsed = installationSchema.safeParse(value);
      if (!parsed.success || parsed.data.sha256 !== sha256)
        throw new StorageError(
          "invalid_state",
          "Stable runner metadata does not match installed entry",
        );
      return { status: "already_installed" as const, filename, installation: parsed.data };
    }
  } else await publishEntry(filename, bytes, assertOwned);
  const installation = {
    schemaVersion: 1 as const,
    sourceBuildId,
    sha256,
    installedAt: new Date().toISOString(),
  };
  await writeJsonAtomic({
    filename: sidecar,
    mode: "publish",
    beforeCommit: assertOwned,
    value: installation,
  });
  return {
    status: present ? ("repaired" as const) : ("installed" as const),
    filename,
    installation,
  };
}
