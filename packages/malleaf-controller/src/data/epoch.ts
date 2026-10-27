import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import {
  dataPolicySchema,
  isRuntimeEntry,
  type DataPolicy,
  type EpochBlocker,
  type SharedDirectories,
} from "./policy.js";
import { findSourcePaths, planConfig } from "./config.js";
import { assertStoragePath } from "../isolation.js";
import {
  exists,
  copyContainedFile,
  hashFile,
  isMissing,
  isWithin,
  prospectiveRealPath,
  readJson,
  relativePath,
  StorageError,
  writeJsonAtomic,
} from "../storage.js";

export interface EpochCopyOptions {
  sourceHome: string;
  dataRoot: string;
  dataId: string;
  buildId: string;
  shared: SharedDirectories;
  policy: DataPolicy;
  protectedPaths?: readonly string[];
  maxUnknownBytes?: number;
}

interface CopyFile {
  kind: "file";
  path: string;
  size: number;
  sha256: string;
  executable: boolean;
}
interface CopyDirectory {
  kind: "directory";
  path: string;
}
interface CopyLink {
  kind: "link";
  path: string;
  target: string;
  directory: boolean;
}
type CopyEntry = CopyFile | CopyDirectory | CopyLink;

export interface EpochCopyPlan {
  options: EpochCopyOptions;
  destination: string;
  entries: CopyEntry[];
  sharedLinks: Record<string, string>;
  excluded: string[];
  blockers: EpochBlocker[];
  config: Record<string, unknown>;
  unknownBytes: number;
  fingerprint: string;
}

function fingerprint(plan: Omit<EpochCopyPlan, "fingerprint">): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

async function inspectShared(
  plan: Omit<EpochCopyPlan, "fingerprint">,
  name: string,
  target: string,
): Promise<void> {
  const source = path.join(plan.options.sourceHome, name);
  if (!(await exists(source))) return;
  const stat = await lstat(source);
  if (stat.isSymbolicLink() && (await realpath(source)) === (await prospectiveRealPath(target)))
    return;
  plan.blockers.push({
    code: "shared_dir_in_home",
    path: name,
    detail:
      "Shared data must be relocated before copying; the original directory will not be changed",
  });
}

async function inspectLink(
  plan: Omit<EpochCopyPlan, "fingerprint">,
  relative: string,
): Promise<void> {
  const sourceHome = await realpath(plan.options.sourceHome);
  const filename = path.join(sourceHome, relative);
  const rawTarget = await readlink(filename);
  let target: string;
  try {
    target = await realpath(filename);
  } catch (error) {
    if (!isMissing(error)) throw error;
    plan.blockers.push({
      code: "external_symlink",
      path: relative,
      detail: `Unresolved link: ${rawTarget}`,
    });
    return;
  }
  if (!isWithin(sourceHome, target)) {
    plan.blockers.push({
      code: "external_symlink",
      path: relative,
      detail: "Declare this external resource as shared before copying",
    });
    return;
  }
  const relativeTarget = path.relative(sourceHome, target).split(path.sep).join("/");
  const stat = await lstat(target);
  plan.entries.push({
    kind: "link",
    path: relative,
    target: relativeTarget,
    directory: stat.isDirectory(),
  });
}

async function inspectEntry(
  plan: Omit<EpochCopyPlan, "fingerprint">,
  relative: string,
  declared: boolean,
): Promise<void> {
  relativePath(relative);
  const filename = path.join(plan.options.sourceHome, relative);
  const stat = await lstat(filename);
  if (stat.isSymbolicLink()) return inspectLink(plan, relative);
  if (stat.isDirectory()) {
    plan.entries.push({ kind: "directory", path: relative });
    for (const child of (await readdir(filename)).sort())
      await inspectEntry(plan, `${relative}/${child}`, declared);
    return;
  }
  if (stat.isSocket()) {
    plan.excluded.push(relative);
    return;
  }
  if (!stat.isFile()) {
    plan.blockers.push({
      code: "unsupported_file",
      path: relative,
      detail: "Only regular files, directories, and declared links can be copied",
    });
    return;
  }
  if (!declared) plan.unknownBytes += stat.size;
  plan.entries.push({
    kind: "file",
    path: relative,
    size: stat.size,
    sha256: await hashFile(filename),
    executable: (stat.mode & 0o100) !== 0,
  });
  if (relative.endsWith(".json") && relative !== "config.json") {
    const stored = await readJson(filename);
    plan.blockers.push(...(await findSourcePaths(stored, plan.options.sourceHome, relative)));
  }
}

export async function planEpochCopy(input: EpochCopyOptions): Promise<EpochCopyPlan> {
  assertStoragePath(input.sourceHome, input.protectedPaths);
  assertStoragePath(input.dataRoot, input.protectedPaths);
  relativePath(input.dataId);
  if (
    input.dataId.includes("/") ||
    input.dataId.endsWith(".partial") ||
    !/^[a-f0-9]{64}$/.test(input.buildId)
  ) {
    throw new StorageError("unsafe_path", "Invalid epoch or build identity");
  }
  const policy = dataPolicySchema.parse(input.policy);
  const sourceHome = await realpath(input.sourceHome);
  const dataRoot = await prospectiveRealPath(input.dataRoot);
  const destination = path.join(dataRoot, input.dataId);
  if (isWithin(sourceHome, destination) || isWithin(destination, sourceHome))
    throw new StorageError("unsafe_path", "Epoch source and destination must be separate");
  const shared = {
    plugins: await prospectiveRealPath(input.shared.plugins),
    worktrees: await prospectiveRealPath(input.shared.worktrees),
    models: await prospectiveRealPath(input.shared.models),
  };
  const sharedLinks: Record<string, string> = { plugins: shared.plugins };
  for (const [name, rule] of Object.entries(policy.entries))
    if (rule.kind === "shared") sharedLinks[name] = await prospectiveRealPath(rule.target);
  for (const target of [...Object.values(shared), ...Object.values(sharedLinks)]) {
    assertStoragePath(target, input.protectedPaths);
    if (
      isWithin(sourceHome, target) ||
      isWithin(dataRoot, target) ||
      isWithin(target, sourceHome) ||
      isWithin(target, dataRoot)
    ) {
      throw new StorageError(
        "unsafe_path",
        "Shared directories must be outside source and epoch storage",
      );
    }
  }
  const options = {
    ...input,
    sourceHome: path.resolve(input.sourceHome),
    dataRoot,
    shared,
    policy,
  };
  const plan: Omit<EpochCopyPlan, "fingerprint"> = {
    options,
    destination,
    entries: [],
    sharedLinks,
    excluded: [],
    blockers: [],
    config: {},
    unknownBytes: 0,
  };
  await inspectSource(plan);
  plan.config = await planConfig({
    sourceHome: options.sourceHome,
    destination,
    shared,
    blockers: plan.blockers,
  });
  plan.blockers.push(...(await findSourcePaths(plan.config, options.sourceHome, "config.json")));
  return { ...plan, fingerprint: fingerprint(plan) };
}

async function inspectSource(plan: Omit<EpochCopyPlan, "fingerprint">): Promise<void> {
  const { sourceHome, shared, policy } = plan.options;
  const { sharedLinks } = plan;
  if (await exists(path.join(sourceHome, "paseo.pid")))
    plan.blockers.push({
      code: "source_locked",
      path: "paseo.pid",
      detail: "Stop the daemon and release its pid lock before copying",
    });
  for (const [name, target] of Object.entries({
    worktrees: shared.worktrees,
    models: path.dirname(shared.models),
    ...sharedLinks,
  }))
    await inspectShared(plan, name, target);
  for (const name of (await readdir(sourceHome)).sort()) {
    const rule = policy.entries[name];
    const isShared = name === "worktrees" || name === "models" || name in sharedLinks;
    if (isRuntimeEntry(name) || rule?.kind === "runtime" || isShared) {
      plan.excluded.push(name);
      continue;
    }
    await inspectEntry(plan, name, rule?.kind === "copied");
  }
  const copiedPaths = new Set(plan.entries.map((entry) => entry.path));
  for (const entry of plan.entries) {
    if (entry.kind === "link" && !copiedPaths.has(entry.target))
      plan.blockers.push({
        code: "internal_link_excluded",
        path: entry.path,
        detail: "The link target is not part of the copied epoch",
      });
  }
  if (plan.unknownBytes > (plan.options.maxUnknownBytes ?? 512 * 1024 * 1024))
    plan.blockers.push({
      code: "size_over_threshold",
      path: sourceHome,
      detail: `${plan.unknownBytes} bytes of undeclared data need a copy/share decision`,
    });
}

interface CopiedEpoch {
  directory: string;
  dataId: string;
  buildId: string;
}

async function copyEntries(plan: EpochCopyPlan, stage: string): Promise<void> {
  for (const entry of plan.entries) {
    const destination = path.join(stage, entry.path);
    if (entry.kind === "directory") await mkdir(destination, { recursive: true, mode: 0o700 });
    if (entry.kind !== "file") continue;
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await copyContainedFile({
      root: await realpath(plan.options.sourceHome),
      source: path.join(plan.options.sourceHome, entry.path),
      destination,
    });
    await chmod(destination, entry.executable ? 0o700 : 0o600);
    if ((await hashFile(destination)) !== entry.sha256)
      throw new StorageError("state_conflict", `Source changed while copying: ${entry.path}`);
  }
  for (const entry of plan.entries) {
    if (entry.kind !== "link") continue;
    const filename = path.join(stage, entry.path);
    const target = path.join(stage, entry.target);
    await symlink(
      path.relative(path.dirname(filename), target),
      filename,
      entry.directory ? "dir" : "file",
    );
  }
  for (const [name, target] of Object.entries(plan.sharedLinks)) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    // Shared targets are outside staging, so a Windows junction survives rename.
    const linkTarget = process.platform === "win32" ? target : path.relative(stage, target);
    await symlink(linkTarget, path.join(stage, name), "junction");
  }
}

export async function executeEpochCopy(plan: EpochCopyPlan): Promise<CopiedEpoch> {
  if (plan.blockers.length) throw new StorageError("epoch_blocked", JSON.stringify(plan.blockers));
  const fresh = await planEpochCopy(plan.options);
  if (fresh.fingerprint !== plan.fingerprint || fresh.blockers.length)
    throw new StorageError("state_conflict", "Epoch source or policy changed after planning");
  const stage = `${fresh.destination}.partial`;
  if ((await exists(stage)) || (await exists(fresh.destination)))
    throw new StorageError("state_conflict", "Epoch identity already exists");
  await mkdir(fresh.options.dataRoot, { recursive: true, mode: 0o700 });
  await mkdir(stage, { mode: 0o700 });
  try {
    await copyEntries(fresh, stage);
    await writeJsonAtomic(path.join(stage, "config.json"), fresh.config);
    const finalSource = await planEpochCopy(fresh.options);
    if (finalSource.fingerprint !== fresh.fingerprint)
      throw new StorageError("state_conflict", "Epoch source changed during copying");
    const files = [];
    for (const entry of fresh.entries) {
      if (entry.kind !== "file" || entry.path === "config.json") continue;
      files.push({ path: entry.path, size: entry.size, sha256: entry.sha256 });
    }
    const configFile = path.join(stage, "config.json");
    files.push({
      path: "config.json",
      size: (await lstat(configFile)).size,
      sha256: await hashFile(configFile),
    });
    await writeJsonAtomic(path.join(stage, "epoch.json"), {
      schemaVersion: 1,
      dataId: fresh.options.dataId,
      buildIdAtCopy: fresh.options.buildId,
      copiedFrom: fresh.options.sourceHome,
      createdAt: new Date().toISOString(),
      files,
      shared: fresh.options.shared,
      excluded: fresh.excluded,
    });
    await rename(stage, fresh.destination);
    return {
      directory: fresh.destination,
      dataId: fresh.options.dataId,
      buildId: fresh.options.buildId,
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
