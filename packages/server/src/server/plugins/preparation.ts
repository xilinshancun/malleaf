import type pino from "pino";
import type { PluginManifest } from "./manifest.js";
import { runCompilerTask } from "./compiler.js";
import { createExternalProcessEnv } from "../paseo-env.js";

export async function runPluginBuild(
  directory: string,
  commands: PluginManifest["build"],
  logger: pino.Logger,
): Promise<void> {
  if (!commands?.length) return;
  await runCompilerTask(
    { kind: "prepare", directory, commands, environment: createExternalProcessEnv(process.env) },
    (data, message) => logger.info(data, message),
  );
}
