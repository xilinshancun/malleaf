import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  MalleafRuntimePointerSelectionSchema,
  type MalleafSelectedPair,
} from "@getpaseo/protocol/malleaf/runtime-pointer";
import type { DaemonInstance } from "../daemon-instance.js";
import { resolveMalleafHome, resolveMalleafDaemonHome } from "./home.js";

export type DesktopDaemonSelection =
  | { ownership: "desktop"; daemonHome: string }
  | {
      ownership: "controller";
      daemonHome: string | null;
      pair: MalleafSelectedPair | null;
      instance: DaemonInstance | null;
      error: string | null;
    };

const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

async function optionalStat(filename: string) {
  try {
    return await lstat(filename);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

async function directoryInside(root: string, directory: string) {
  if (!(await lstat(directory)).isDirectory())
    throw new Error("Selected runtime directory must be physical");
  const canonical = await realpath(directory);
  const relative = path.relative(root, canonical);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error("Selected runtime directory escapes its product home");
  return canonical;
}

// readInstance is injected to keep this environment export independent of the
// daemon-control startup graph. This function never starts, signals or writes.
export async function resolveDesktopDaemonSelection(options: {
  env?: NodeJS.ProcessEnv;
  readInstance(home: string): Promise<DaemonInstance | null>;
}): Promise<DesktopDaemonSelection> {
  const env = options.env ?? process.env;
  try {
    const home = resolveMalleafHome(env);
    const runner = path.join(home, "runner");
    if (!(await optionalStat(runner)))
      return { ownership: "desktop", daemonHome: resolveMalleafDaemonHome(env) };
    // A redirected runner is not absence of ownership.
    const root = await realpath(home);
    await directoryInside(root, runner);
    const filename = path.join(runner, "current.json");
    const info = await optionalStat(filename);
    if (!info)
      throw new Error("Controller initialization is incomplete: runtime pointer is missing");
    if (!info.isFile()) throw new Error("Runtime pointer must be a regular file");
    const bytes = await readFile(filename, "utf8");
    const pointer = MalleafRuntimePointerSelectionSchema.parse(JSON.parse(bytes));
    if (pointer.minReaderVersion > 1 || pointer.minReaderVersion > pointer.schemaVersion)
      throw new Error("Runtime pointer requires a newer reader");
    if (pointer.trial?.pair.dataId === pointer.current.dataId)
      throw new Error("Current and trial must use separate epochs");
    const dataRoot = await directoryInside(root, path.join(root, "data"));
    const pairs = pointer.trial ? [pointer.current, pointer.trial.pair] : [pointer.current];
    const candidates = await Promise.all(
      pairs.map(async (pair) => {
        const daemonHome = await directoryInside(dataRoot, path.join(dataRoot, pair.dataId));
        return { daemonHome, pair, instance: await options.readInstance(daemonHome) };
      }),
    );
    if ((await readFile(filename, "utf8")) !== bytes)
      throw new Error("Runtime selection changed; retry status");
    const live = candidates.filter((candidate) => candidate.instance !== null);
    if (live.length > 1) throw new Error("Multiple selected runtime epochs are alive");
    const selected = live[0] ?? candidates[0]!;
    return { ownership: "controller", ...selected, error: null };
  } catch (error) {
    return {
      ownership: "controller",
      daemonHome: null,
      pair: null,
      instance: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
