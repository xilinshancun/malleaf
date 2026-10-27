import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { exists, isWithin, prospectiveRealPath, readJson } from "../storage.js";
import type { EpochBlocker, SharedDirectories } from "./policy.js";

const object = z.record(z.string(), z.unknown());
function section(value: unknown): Record<string, unknown> {
  return value === undefined ? {} : object.parse(value);
}

interface ConfigOptions {
  sourceHome: string;
  destination: string;
  shared: SharedDirectories;
  blockers: EpochBlocker[];
}

export async function planConfig({
  sourceHome,
  destination,
  shared,
  blockers,
}: ConfigOptions): Promise<Record<string, unknown>> {
  const filename = path.join(sourceHome, "config.json");
  const config = (await exists(filename)) ? object.parse(await readJson(filename)) : {};
  const homeNames = [path.resolve(sourceHome), await prospectiveRealPath(sourceHome)];
  const worktrees = section(config.worktrees);
  const providers = section(config.providers);
  const local = section(providers.local);
  config.worktrees = { ...worktrees, root: shared.worktrees };
  config.providers = { ...providers, local: { ...local, modelsDir: shared.models } };

  const log = section(config.log);
  const logFile = section(log.file);
  const logPath = logFile.path;
  const logHome =
    typeof logPath === "string"
      ? homeNames.find((home) => isWithin(home, path.resolve(logPath)))
      : undefined;
  if (logHome && typeof logPath === "string") {
    config.log = {
      ...log,
      file: { ...logFile, path: path.join(destination, path.relative(logHome, logPath)) },
    };
  }
  const features = section(config.features);
  const webUi = section(features.webUi);
  const ports = section(worktrees.servicePorts);
  for (const [key, value] of [
    ["features.webUi.distDir", webUi.distDir],
    ["worktrees.servicePorts.portScript", ports.portScript],
  ]) {
    if (
      typeof value === "string" &&
      homeNames.some((home) => isWithin(home, path.resolve(value)))
    ) {
      blockers.push({
        code: "config_path_unmapped",
        path: String(key),
        detail: `Move this resource outside the data epoch: ${value}`,
      });
    }
  }
  const sourcesFile = path.join(shared.plugins, "sources.json");
  const managed = (await exists(sourcesFile)) ? object.parse(await readJson(sourcesFile)) : {};
  const plugins = section(config.plugins);
  for (const [id, raw] of Object.entries(plugins)) {
    const plugin = object.parse(raw);
    if (typeof plugin.path !== "string") continue;
    const pluginPath = plugin.path;
    const pluginRoots = homeNames.map((home) => path.join(home, "plugins", id));
    const previousRoot = pluginRoots.find((root) => isWithin(root, path.resolve(pluginPath)));
    if (id in managed && previousRoot) {
      plugins[id] = {
        ...plugin,
        path: path.join(destination, "plugins", id, path.relative(previousRoot, plugin.path)),
      };
    } else if (homeNames.some((home) => isWithin(home, path.resolve(pluginPath)))) {
      blockers.push({
        code: "config_path_unmapped",
        path: `plugins.${id}.path`,
        detail: "Move this directory plugin outside the data epoch before activation",
      });
    }
  }
  if (config.plugins !== undefined) config.plugins = plugins;
  return config;
}

// Custom code can persist paths in any JSON document. Refuse unresolved ownership
// instead of letting a candidate write through an old epoch's absolute path.
export async function findSourcePaths(
  value: unknown,
  sourceHome: string,
  filename: string,
): Promise<EpochBlocker[]> {
  const homeNames = [path.resolve(sourceHome), await prospectiveRealPath(sourceHome)];
  const strings: string[] = [];
  function visit(item: unknown): void {
    if (typeof item === "string") {
      if (path.isAbsolute(item)) strings.push(item);
      else if (item.startsWith("file://")) strings.push(fileURLToPath(item));
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    const parsed = object.safeParse(item);
    if (parsed.success)
      for (const [key, child] of Object.entries(parsed.data)) {
        visit(key);
        visit(child);
      }
  }
  visit(value);
  const blockers: EpochBlocker[] = [];
  for (const reference of new Set(strings)) {
    const lexical = path.resolve(reference);
    const canonical = await prospectiveRealPath(reference);
    const ignoreCase = process.platform === "darwin" || process.platform === "win32";
    const normalize = (name: string) => (ignoreCase ? name.toLowerCase() : name);
    if (
      homeNames.some(
        (home) =>
          isWithin(normalize(home), normalize(lexical)) ||
          isWithin(normalize(home), normalize(canonical)),
      )
    ) {
      blockers.push({
        code: "source_path_in_json",
        path: filename,
        detail: `Stored path still refers to the source epoch: ${reference}`,
      });
    }
  }
  return blockers;
}
