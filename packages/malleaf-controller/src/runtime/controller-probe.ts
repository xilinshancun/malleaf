import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { verifySlot } from "../slot/materialize.js";
import { containedRealPath, StorageError } from "../storage.js";
import { readRunnerConfiguration } from "../runner/initialize.js";
import { assertSlotDependencyBoundary } from "./daemon.js";
import { isolateRuntimeNodeEnvironment } from "./environment.js";

// A self-check child never receives the ACK that authorizes lease acquisition.
// It must report its own build and exit before activation can drain the baseline.
export async function verifyCandidateController(options: {
  slotDirectory: string;
  buildId: string;
  home: string;
  acceptanceRoot: string;
  environment: NodeJS.ProcessEnv;
  assertOwned(): void;
  timeoutMs?: number;
}): Promise<void> {
  options.assertOwned();
  const slot = await realpath(options.slotDirectory);
  const manifest = await verifySlot({
    directory: slot,
    expectedBuildId: options.buildId,
    mode: "full",
  });
  if (!manifest.entries.controller)
    throw new StorageError("incomplete_artifact", "Candidate has no controller entry");
  const entry = await containedRealPath(slot, path.join(slot, manifest.entries.controller));
  await assertSlotDependencyBoundary(slot);
  const config = await readRunnerConfiguration(options.home);
  options.assertOwned();
  await new Promise<void>((resolve, reject) => {
    let verified = false;
    let timedOut = false;
    let processError: Error | undefined;
    let stderr = "";
    const child = spawn(
      process.execPath,
      [
        entry,
        "--verify",
        "--home",
        options.home,
        "--acceptance-root",
        options.acceptanceRoot,
        "--control-port",
        String(config.controlPort),
      ],
      {
        env: {
          ...isolateRuntimeNodeEnvironment(options.environment),
          TMPDIR: os.tmpdir(),
          TMP: os.tmpdir(),
          TEMP: os.tmpdir(),
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch (error) {
        processError = error instanceof Error ? error : new Error(String(error));
      }
    }, options.timeoutMs ?? 10_000);
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-16_384);
    });
    child.on("message", (message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "malleaf.controller.verified" &&
        "buildId" in message &&
        message.buildId === options.buildId
      )
        verified = true;
      // In particular, loaded is never answered with proceed.
    });
    child.on("error", (error) => {
      processError = error;
      if (child.pid === undefined) {
        clearTimeout(timer);
        reject(error);
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (!timedOut && !processError && verified && code === 0 && signal === null) {
        resolve();
        return;
      }
      const error = new StorageError(
        "state_conflict",
        `Candidate controller self-check failed: verified=${verified}, timeout=${timedOut}, exit=${code}, signal=${signal}; ${stderr}`,
      );
      if (processError) error.cause = processError;
      reject(error);
    });
  });
  options.assertOwned();
}
