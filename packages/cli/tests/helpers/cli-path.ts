import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
export const CLI_BIN_PATH = realpathSync(path.join(packageRoot, "bin/paseo"));
if (!CLI_BIN_PATH.startsWith(`${packageRoot}${path.sep}`))
  throw new Error("CLI tests must execute this repository's CLI.");
