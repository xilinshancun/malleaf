// The existing synchronous resolvePaseoHome API is used before process startup.
// Resolve symlinks at this boundary before callers create or write a home.
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { malleafIdentity } from "@getpaseo/protocol/malleaf/product-identity";

export class MalleafHomeIsolationError extends Error {
  constructor(public readonly directory: string) {
    super(
      `Malleaf cannot use the installed Paseo home: ${directory}. Set MALLEAF_HOME to a separate directory.`,
    );
    this.name = "MalleafHomeIsolationError";
  }
}

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function canonicalMalleafPath(directory: string, depth = 0): string {
  if (depth > 40) throw new MalleafHomeIsolationError(directory);
  let existing = directory;
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(existing), ...missing);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
      // realpath fails for a dangling symlink. Still resolve its target before
      // comparing a directory that the launcher is about to create.
      try {
        if (lstatSync(existing).isSymbolicLink()) {
          return path.join(
            canonicalMalleafPath(
              path.resolve(path.dirname(existing), readlinkSync(existing)),
              depth + 1,
            ),
            ...missing,
          );
        }
      } catch (linkError) {
        if (!(linkError instanceof Error) || !("code" in linkError) || linkError.code !== "ENOENT")
          throw linkError;
      }
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

export function assertMalleafHomeIsolated(
  directory: string,
  additionalProtected: readonly string[] = [],
): void {
  const normalize = (value: string) =>
    process.platform === "darwin" || process.platform === "win32" ? value.toLowerCase() : value;
  const resolved = normalize(canonicalMalleafPath(path.resolve(directory)));
  const protectedDirectories = [
    path.join(os.homedir(), ".paseo"),
    path.join(os.homedir(), "Library", "Application Support", "Paseo"),
    path.join(os.homedir(), ".config", "Paseo"),
    ...(process.env.APPDATA ? [path.join(process.env.APPDATA, "Paseo")] : []),
    ...additionalProtected,
  ];
  for (const protectedDirectory of protectedDirectories) {
    const protectedPath = normalize(
      canonicalMalleafPath(path.resolve(expandHome(protectedDirectory))),
    );
    if (
      resolved === protectedPath ||
      resolved.startsWith(`${protectedPath}${path.sep}`) ||
      protectedPath.startsWith(`${resolved}${path.sep}`)
    ) {
      throw new MalleafHomeIsolationError(directory);
    }
  }
}

export function resolveMalleafHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.MALLEAF_HOME ?? path.join(os.homedir(), malleafIdentity.homeDirectory);
  const resolved = path.resolve(expandHome(home));
  assertMalleafHomeIsolated(resolved);
  return resolved;
}

export function resolveMalleafDaemonHome(env: NodeJS.ProcessEnv = process.env): string {
  const defaultHome = path.join(resolveMalleafHome(env), malleafIdentity.daemonDirectory);
  // Only the product namespace selects state, including raw supervisor starts.
  const daemonHome = env.MALLEAF_DAEMON_HOME ?? defaultHome;
  const resolved = path.resolve(expandHome(daemonHome));
  assertMalleafHomeIsolated(resolved);
  return resolved;
}
