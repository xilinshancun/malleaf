import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import { assertMalleafHomeIsolated } from "@getpaseo/server/malleaf-runtime";

function canonicalBoundary(filename: string): string {
  try {
    return realpathSync(filename);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    const parent = path.dirname(filename);
    if (parent === filename) return filename;
    return path.join(canonicalBoundary(parent), path.basename(filename));
  }
}

// TMPDIR/HOME are caller-controlled. Protect installed state independently,
// while allowing Windows Temp beneath the account home.
export function assertAcceptanceBoundary(root: string, home: string): void {
  const normalize = (value: string) =>
    process.platform === "win32" || process.platform === "darwin" ? value.toLowerCase() : value;
  const native = canonicalBoundary(os.userInfo().homedir);
  const contains = (parent: string, child: string) =>
    child === parent || child.startsWith(`${parent}${path.sep}`);
  const roots = [root, home].map((value) => normalize(canonicalBoundary(value)));
  if (contains(roots[0]!, normalize(native)))
    throw new Error("Acceptance root cannot contain the account home");
  for (const relative of [
    ".malleaf",
    ".malleaf-dev",
    ".paseo",
    "Library/Application Support/Malleaf",
    "Library/Application Support/Paseo",
    "Library/Logs/Malleaf",
    "Library/Logs/Paseo",
    ".config/Malleaf",
    ".config/Paseo",
    "AppData/Roaming/Malleaf",
    "AppData/Roaming/Paseo",
  ]) {
    const protectedPath = normalize(canonicalBoundary(path.join(native, relative)));
    if (roots.some((value) => contains(value, protectedPath) || contains(protectedPath, value)))
      throw new Error("Acceptance directories overlap installed product state");
  }
}

export function assertStoragePath(
  directory: string,
  additionalProtected: readonly string[] = [],
): void {
  const nativeHome = os.userInfo().homedir;
  const hostHome = process.env.MALLEAF_HOST_PASEO_HOME;
  const foreignPaseoHome =
    process.env.PASEO_HOME !== process.env.MALLEAF_DAEMON_HOME ? process.env.PASEO_HOME : undefined;
  const protectedPaths = [
    path.join(nativeHome, ".paseo"),
    path.join(nativeHome, "Library", "Application Support", "Paseo"),
    path.join(nativeHome, ".config", "Paseo"),
    ...additionalProtected,
  ];
  if (hostHome) protectedPaths.push(hostHome);
  if (foreignPaseoHome) protectedPaths.push(foreignPaseoHome);
  assertMalleafHomeIsolated(directory, protectedPaths);
}
