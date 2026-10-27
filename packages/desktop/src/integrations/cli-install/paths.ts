import path from "node:path";
import { malleafIdentity } from "@getpaseo/protocol/malleaf/product-identity";
import { createRequire } from "node:module";
import { resolveCliShimPath } from "./path.js";
import os from "node:os";
import { app } from "electron";

export function getLocalBinDir(): string {
  return path.join(os.homedir(), ".local", "bin");
}

export function getCliTargetPath(): string {
  const filename = `${malleafIdentity.cliName}${process.platform === "win32" ? ".cmd" : ""}`;
  return path.join(getLocalBinDir(), filename);
}

export function getBundledCliShimPath(): string {
  return resolveCliShimPath({
    platform: process.platform,
    isPackaged: app.isPackaged,
    executablePath: app.getPath("exe"),
    resolveWorkspaceCli: () => createRequire(__filename).resolve("@getpaseo/cli/bin/paseo"),
  });
}
