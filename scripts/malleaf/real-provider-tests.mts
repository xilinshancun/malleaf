import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createMalleafEnvironment } from "../../packages/server/src/server/malleaf/environment.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const development = createMalleafEnvironment(process.env, { developmentRoot: repository });
const env = { ...process.env, E2E_USE_HOST_HARNESS: "1" };
if (!env.E2E_FORK_PASEO_HOME_FROM) {
  // An existing development profile supplies custom provider configuration.
  // A fresh checkout can use harness discovery without seeding personal state.
  try {
    await access(path.join(development.MALLEAF_DAEMON_HOME!, "config.json"));
    env.E2E_FORK_PASEO_HOME_FROM = development.MALLEAF_DAEMON_HOME;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
}
const [project = "real-provider", ...args] = process.argv.slice(2);
const child = spawn(
  process.execPath,
  [
    path.join(repository, "node_modules/playwright/cli.js"),
    "test",
    `--project=${project}`,
    ...args,
  ],
  {
    cwd: path.join(repository, "packages/app"),
    env,
    stdio: "inherit",
  },
);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  throw error;
});
child.on("exit", (code) => process.exit(code ?? 1));
