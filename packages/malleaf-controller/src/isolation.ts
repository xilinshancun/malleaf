import os from "node:os";
import path from "node:path";
import { assertMalleafHomeIsolated } from "@getpaseo/server/malleaf-runtime";

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
