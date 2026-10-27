import { spawn } from "node:child_process";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { createMalleafEnvironment } from "../src/server/malleaf/environment.js";

dotenv.config({
  path: fileURLToPath(new URL("../.env", import.meta.url)),
  quiet: true,
});

const daemonRunnerEntry = fileURLToPath(new URL("./supervisor-entrypoint.ts", import.meta.url));
const developmentRoot = fileURLToPath(new URL("../../../", import.meta.url));
const derivedEnvironment = createMalleafEnvironment(process.env, { developmentRoot });
// The shell launcher may have allocated a service port for this checkout.
// A raw dev invocation must not inherit another checkout's runtime state.
const developmentEnvironment = createMalleafEnvironment(process.env, {
  developmentRoot,
  developmentListen:
    process.env.MALLEAF_DAEMON_HOME === derivedEnvironment.MALLEAF_DAEMON_HOME
      ? process.env.MALLEAF_LISTEN
      : undefined,
});

const supervisorArgs = [...process.execArgv, daemonRunnerEntry, "--dev", ...process.argv.slice(2)];

const supervisor = spawn(process.execPath, supervisorArgs, {
  stdio: "inherit",
  env: {
    ...developmentEnvironment,
    MALLEAF_LOG_FORMAT: developmentEnvironment.MALLEAF_LOG_FORMAT ?? "pretty",
  },
});

function exitCodeForSignal(signal: NodeJS.Signals): number {
  return signal === "SIGINT" ? 130 : 1;
}

function forwardSignal(signal: NodeJS.Signals): void {
  if (supervisor.exitCode !== null || supervisor.signalCode !== null || supervisor.killed) {
    return;
  }
  supervisor.kill(signal);
}

// The supervisor handles SIGINT/SIGTERM itself and needs time to drain the
// worker gracefully. Keep this wrapper alive until the supervisor exits so npm
// does not release the shell while the daemon is still logging final shutdown.
process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

supervisor.on("error", (error) => {
  throw error;
});

supervisor.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? exitCodeForSignal(signal) : 1));
});
