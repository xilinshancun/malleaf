import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { assertStoragePath } from "../isolation.js";
import { containedRealPath, exists, StorageError, writeJsonAtomic } from "../storage.js";
import { acquireControlLease } from "./lease.js";
import {
  inspectPointer,
  openPointerStore,
  runtimePairSchema,
  verifyRuntimePair,
  type RuntimePair,
} from "./pointer.js";

const runnerSchema = z.looseObject({
  schemaVersion: z.number().int().positive(),
  minReaderVersion: z.number().int().positive(),
  minWriterVersion: z.number().int().positive(),
  controlPort: z.number().int().min(1).max(65535),
  initToken: z.string().regex(/^[a-f0-9]{64}$/),
  initialPair: runtimePairSchema,
  createdAt: z.string().datetime(),
});
type RunnerConfiguration = z.infer<typeof runnerSchema>;

interface InitializationOptions {
  home: string;
  initialPair?: RuntimePair;
}
interface InitializationResult {
  status: "initialized" | "resumed" | "already_initialized";
  controlPort: number;
  pair: RuntimePair;
}

async function readConfiguration(filename: string): Promise<RunnerConfiguration> {
  if (!(await lstat(filename)).isFile())
    throw new StorageError("unsafe_path", "Runner configuration must be a regular file");
  let config: RunnerConfiguration;
  try {
    config = runnerSchema.parse(JSON.parse(await readFile(filename, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError)
      throw new StorageError(
        "invalid_state",
        "Runner configuration is invalid; initialization cannot replace it",
      );
    throw error;
  }
  const invalidRequirements =
    config.minReaderVersion > config.schemaVersion ||
    config.minWriterVersion > config.schemaVersion;
  if (config.minReaderVersion > 1 || invalidRequirements)
    throw new StorageError(
      "unsupported_schema",
      "This runtime cannot read the runner configuration",
    );
  return config;
}

async function reservePort(home: string, buildId: string) {
  const start = createHash("sha256").update(home).digest().readUInt16BE(0) % 12768;
  for (let offset = 0; offset < 32; offset++) {
    const port = 20000 + ((start + offset) % 12768);
    try {
      return await acquireControlLease({ home, port, buildId, role: "init" });
    } catch (error) {
      if (!(error instanceof StorageError) || !["lease_held", "port_occupied"].includes(error.code))
        throw error;
    }
  }
  throw new StorageError(
    "port_occupied",
    "No control port is available in the initialization range",
  );
}

export async function initializeRuntime(
  options: InitializationOptions,
): Promise<InitializationResult> {
  assertStoragePath(options.home);
  const runner = path.join(options.home, "runner");
  assertStoragePath(runner);
  await mkdir(runner, { recursive: true, mode: 0o700 });
  const home = await realpath(options.home);
  await containedRealPath(home, runner);
  if (!(await lstat(runner)).isDirectory())
    throw new StorageError("unsafe_path", "Runner must be a physical directory");
  const configFile = path.join(runner, "runner.json");
  const pointerFile = path.join(runner, "current.json");
  const existing = (await exists(configFile)) ? await readConfiguration(configFile) : undefined;
  if (await exists(pointerFile)) {
    if (!existing)
      throw new StorageError(
        "state_conflict",
        "Current selection exists without runner configuration",
      );
    const pointer = await inspectPointer(home);
    return {
      status: "already_initialized",
      controlPort: existing.controlPort,
      pair: pointer.current,
    };
  }
  if (!existing && !options.initialPair)
    throw new StorageError(
      "state_conflict",
      "A new runtime requires an explicit complete initial pair",
    );
  if (existing && existing.minWriterVersion > 1)
    throw new StorageError(
      "unsupported_schema",
      "This runtime cannot finish the newer initialization",
    );
  const pair = runtimePairSchema.parse(existing?.initialPair ?? options.initialPair);
  await verifyRuntimePair({ home, pair });
  const lease = existing
    ? await acquireControlLease({
        home,
        port: existing.controlPort,
        buildId: pair.buildId,
        role: "init",
      })
    : await reservePort(home, pair.buildId);
  let store: Awaited<ReturnType<typeof openPointerStore>> | undefined;
  try {
    if (!existing) {
      await writeJsonAtomic({
        filename: configFile,
        mode: "publish",
        beforeCommit: lease.assertOwned,
        value: {
          schemaVersion: 1,
          minReaderVersion: 1,
          minWriterVersion: 1,
          controlPort: lease.port,
          initToken: randomBytes(32).toString("hex"),
          initialPair: pair,
          createdAt: new Date().toISOString(),
        },
      });
    } else {
      const latest = await readConfiguration(configFile);
      if (JSON.stringify(latest) !== JSON.stringify(existing))
        throw new StorageError(
          "state_conflict",
          "Runner configuration changed while acquiring ownership",
        );
    }
    await lease.publishIdentity();
    store = await openPointerStore({
      home,
      initial: pair,
      writerToken: lease.token,
      assertOwned: lease.assertOwned,
    });
    const pointer = await store.read();
    return {
      status: existing ? "resumed" : "initialized",
      controlPort: lease.port,
      pair: pointer.current,
    };
  } finally {
    await lease.release({
      seal: async () => {
        if (store) await store.seal();
      },
    });
  }
}
