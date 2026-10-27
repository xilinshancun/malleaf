import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import {
  buildIdentity,
  provenanceSchema,
  slotManifestSchema,
  type ArtifactRecord,
  type Provenance,
  type SlotManifest,
} from "./manifest.js";
import {
  containedRealPath,
  copyContainedFile,
  exists,
  hashFile,
  isWithin,
  readJson,
  relativePath,
  StorageError,
  writeJsonAtomic,
} from "../storage.js";
import { assertStoragePath } from "../isolation.js";

const manifestName = "malleaf.json";

export interface MaterializeOptions {
  sourceRoot: string;
  versionsRoot: string;
  paths: string[];
  entries: Record<string, string>;
  provenance: Provenance;
  protectedPaths?: readonly string[];
}

export interface MaterializedSlot {
  directory: string;
  manifest: SlotManifest;
}

async function collectArtifacts(directory: string, prefix = ""): Promise<ArtifactRecord[]> {
  const records: ArtifactRecord[] = [];
  for (const name of await readdir(path.join(directory, prefix))) {
    const relative = prefix ? `${prefix}/${name}` : name;
    if (relative === manifestName) continue;
    relativePath(relative);
    const filename = path.join(directory, relative);
    const stat = await lstat(filename);
    if (stat.isSymbolicLink()) {
      const target = await readlink(filename);
      if (path.isAbsolute(target))
        throw new StorageError("unsafe_path", `Absolute artifact link: ${relative}`);
      await containedRealPath(directory, filename);
      records.push({ kind: "link", path: relative, target: target.split(path.sep).join("/") });
    } else if (stat.isDirectory()) {
      records.push(...(await collectArtifacts(directory, relative)));
    } else if (stat.isFile()) {
      const executable = process.platform !== "win32" && (stat.mode & 0o111) !== 0;
      records.push({
        kind: "file",
        path: relative,
        sha256: await hashFile(filename),
        size: stat.size,
        executable,
      });
    } else {
      throw new StorageError("unsafe_path", `Non-file artifact: ${relative}`);
    }
  }
  return records.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

async function setReadOnly(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, item.name);
    if (item.isDirectory()) await setReadOnly(filename);
    if (item.isFile()) {
      const stat = await lstat(filename);
      await chmod(filename, (stat.mode & 0o111) !== 0 ? 0o555 : 0o444);
    }
  }
  await chmod(directory, 0o555);
}

async function copyClosure(options: MaterializeOptions, stage: string): Promise<void> {
  const sourceRoot = await realpath(options.sourceRoot);
  const links: string[] = [];
  // nft reports both physical files and workspace directory links. Copy physical
  // files first so no write is ever redirected through a staged link.
  for (const relative of new Set(options.paths)) {
    relativePath(relative);
    if (relative === manifestName)
      throw new StorageError("unsafe_path", "The slot manifest is reserved");
    const source = path.join(sourceRoot, relative);
    await containedRealPath(sourceRoot, source);
    const stat = await lstat(source);
    const destination = path.join(stage, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    if (stat.isSymbolicLink()) {
      links.push(relative);
    } else if (stat.isDirectory()) {
      await mkdir(destination, { recursive: true });
    } else if (stat.isFile()) {
      await copyContainedFile({ root: sourceRoot, source, destination });
    } else {
      throw new StorageError("unsafe_path", `Non-file source: ${relative}`);
    }
  }
  for (const relative of links) {
    const source = path.join(sourceRoot, relative);
    const target = await containedRealPath(sourceRoot, source);
    const destination = path.join(stage, relative);
    const slotTarget = path.join(stage, path.relative(sourceRoot, target));
    const targetStat = await lstat(slotTarget);
    await symlink(
      path.relative(path.dirname(destination), slotTarget),
      destination,
      targetStat.isDirectory() ? "dir" : "file",
    );
  }
}

export async function materializeSlot(options: MaterializeOptions): Promise<MaterializedSlot> {
  const provenance = provenanceSchema.parse(options.provenance);
  assertStoragePath(options.versionsRoot, options.protectedPaths);
  await mkdir(options.versionsRoot, { recursive: true });
  const versionsRoot = await realpath(options.versionsRoot);
  const sourceRoot = await realpath(options.sourceRoot);
  if (isWithin(sourceRoot, versionsRoot) || isWithin(versionsRoot, sourceRoot)) {
    throw new StorageError("unsafe_path", "Source and versions directories must be separate");
  }
  const stage = await mkdtemp(path.join(versionsRoot, ".slot-"));
  try {
    await copyClosure(options, stage);
    const files = await collectArtifacts(stage);
    const manifest = slotManifestSchema.parse({
      schemaVersion: 1,
      buildId: buildIdentity({ files, entries: options.entries, provenance }),
      provenance,
      entries: options.entries,
      files,
    });
    await writeJsonAtomic(path.join(stage, manifestName), manifest);
    await verifyContents(stage, manifest, "full");
    const directory = path.join(versionsRoot, manifest.buildId);
    if (await exists(directory)) {
      const existing = await verifySlot({
        directory,
        mode: "full",
        expectedBuildId: manifest.buildId,
      });
      return { directory, manifest: existing };
    }
    try {
      await rename(stage, directory);
    } catch (error) {
      const conflict =
        error instanceof Error &&
        "code" in error &&
        ["EEXIST", "ENOTEMPTY", "EPERM"].includes(String(error.code));
      if (!conflict || !(await exists(directory))) throw error;
      const existing = await verifySlot({
        directory,
        mode: "full",
        expectedBuildId: manifest.buildId,
      });
      return { directory, manifest: existing };
    }
    await setReadOnly(directory);
    return { directory, manifest };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export interface VerifyOptions {
  directory: string;
  mode: "entries" | "full";
  expectedBuildId: string;
}

export async function verifySlot({
  directory,
  mode,
  expectedBuildId,
}: VerifyOptions): Promise<SlotManifest> {
  const root = await realpath(directory);
  const manifestFile = path.join(root, manifestName);
  if (!(await lstat(manifestFile)).isFile())
    throw new StorageError("incomplete_artifact", "Manifest must be a regular file");
  const manifest = slotManifestSchema.parse(await readJson(manifestFile));
  if (manifest.buildId !== expectedBuildId || path.basename(root) !== expectedBuildId) {
    throw new StorageError(
      "artifact_changed",
      "Slot directory and manifest do not match the selected build",
    );
  }
  await verifyContents(root, manifest, mode);
  return manifest;
}

async function verifyContents(
  root: string,
  manifest: SlotManifest,
  mode: "entries" | "full",
): Promise<void> {
  if (buildIdentity(manifest) !== manifest.buildId)
    throw new StorageError("artifact_changed", "Manifest identity does not match its inventory");
  const inventory = new Map(manifest.files.map((record) => [record.path, record]));
  if (inventory.size !== manifest.files.length)
    throw new StorageError("incomplete_artifact", "Duplicate artifact paths");
  for (const entry of Object.values(manifest.entries)) {
    const record = inventory.get(entry);
    if (record?.kind !== "file")
      throw new StorageError("incomplete_artifact", `Missing executable/resource entry: ${entry}`);
    const filename = await containedRealPath(root, path.join(root, entry));
    if ((await hashFile(filename)) !== record.sha256)
      throw new StorageError("artifact_changed", `Changed entry: ${entry}`);
  }
  if (
    mode === "full" &&
    buildIdentity({ ...manifest, files: await collectArtifacts(root) }) !== manifest.buildId
  ) {
    throw new StorageError("artifact_changed", "Slot contents no longer match the manifest");
  }
}
