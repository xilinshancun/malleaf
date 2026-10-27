import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createHostClient } from "@getpaseo/client/node";
import {
  type DaemonInstance,
  DaemonInstanceError,
  isSameDaemonInstance,
  readDaemonInstance,
  readLocalCredentialForTarget,
  startDaemonInstance,
  stopDaemonInstance,
  waitForDaemonReady,
} from "@getpaseo/server/daemon-control";
import { assertStoragePath } from "../isolation.js";
import { verifySlot } from "../slot/materialize.js";
import type { SlotManifest } from "../slot/manifest.js";
import { containedRealPath, exists, StorageError } from "../storage.js";
import { isolateRuntimeNodeEnvironment } from "./environment.js";

export async function assertSlotDependencyBoundary(slot: string): Promise<void> {
  // Node walks every ancestor when a dependency is absent from the slot. Refuse
  // that layout instead of allowing an incomplete trace to borrow host code.
  for (let parent = path.dirname(slot); ; parent = path.dirname(parent)) {
    if (await exists(path.join(parent, "node_modules")))
      throw new StorageError("unsafe_path", `Slot ancestor contains node_modules: ${parent}`);
    if (path.dirname(parent) === parent) break;
  }
}

interface RuntimeTarget {
  slotDirectory: string;
  buildId: string;
  daemonHome: string;
  clientId: string;
  assertOwned(): void;
  timeoutMs?: number;
}
interface RuntimeLaunchOptions extends RuntimeTarget {
  environment: NodeJS.ProcessEnv;
  recordInstance?(instance: DaemonInstance): Promise<void>;
  signal?: AbortSignal;
}
interface RuntimeAttachOptions extends RuntimeTarget {
  expected: DaemonInstance;
}
interface RuntimeStopOptions extends Pick<
  RuntimeTarget,
  "daemonHome" | "clientId" | "assertOwned"
> {
  instance: DaemonInstance;
}

export class RuntimeLaunchError extends Error {
  constructor(
    readonly cleanup: "verified" | "unverified",
    cause: unknown,
    readonly instance?: DaemonInstance,
  ) {
    super(
      `Runtime launch failed (cleanup ${cleanup}): ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "RuntimeLaunchError";
  }
}

async function connectRuntime(home: string, listen: string, clientId: string, timeoutMs: number) {
  const client = createHostClient(listen, {
    clientId,
    clientType: "cli",
    connectTimeoutMs: timeoutMs,
    localCredential: () => readLocalCredentialForTarget(home, listen) ?? undefined,
    reconnect: { enabled: false },
  });
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

async function verifyRuntimeHandshake(
  home: string,
  manifest: SlotManifest,
  instance: DaemonInstance,
  client: Awaited<ReturnType<typeof connectRuntime>>,
) {
  const info = client.getLastServerInfoMessage();
  const serverId = (await readFile(path.join(home, "server-id"), "utf8")).trim();
  if (
    !info ||
    info.features?.malleaf !== true ||
    !info.permissions?.includes("daemon.manage") ||
    info.malleaf?.buildId !== manifest.buildId ||
    info.malleaf.product !== manifest.provenance.product ||
    info.malleaf.display !== manifest.provenance.display ||
    info.malleaf.upstream !== manifest.provenance.upstream ||
    info.serverId !== serverId ||
    (instance.serverId && instance.serverId !== serverId)
  )
    throw new StorageError(
      "identity_conflict",
      "Runtime hello does not match the verified slot and daemon identity",
    );
  const current = await readDaemonInstance(home);
  if (!current || !isSameDaemonInstance(current, instance))
    throw new StorageError("state_conflict", "Supervisor changed during the runtime handshake");
  return info;
}

async function verifyRuntimeSlot(options: RuntimeTarget) {
  options.assertOwned();
  assertStoragePath(options.daemonHome);
  const slot = await realpath(options.slotDirectory);
  await assertSlotDependencyBoundary(slot);
  const manifest = await verifySlot({
    directory: slot,
    expectedBuildId: options.buildId,
    mode: "full",
  });
  const entries: Record<string, string> = {};
  for (const name of ["supervisor", "worker", "cli"]) {
    const entry = manifest.entries[name];
    if (!entry) throw new StorageError("incomplete_artifact", `Slot has no ${name} entry`);
    entries[name] = await containedRealPath(slot, path.join(slot, entry));
  }
  return { slot, entries, manifest };
}

export async function stopRuntimeInstance(options: RuntimeStopOptions): Promise<void> {
  options.assertOwned();
  assertStoragePath(options.daemonHome);
  await stopDaemonInstance(options.daemonHome, {
    instance: options.instance,
    timeoutMs: 15_000,
    requestShutdown: async (ready) => {
      const client = await connectRuntime(options.daemonHome, ready.listen, options.clientId, 5000);
      try {
        await client.shutdownServer({ timeout: 5000 });
      } finally {
        await client.close();
      }
    },
  });
  if (await readDaemonInstance(options.daemonHome))
    throw new StorageError("state_conflict", "Daemon stop did not leave an empty runtime home");
}

async function connectRuntimeHandle(
  options: RuntimeTarget,
  manifest: SlotManifest,
  instance: DaemonInstance & { listen: string },
) {
  options.assertOwned();
  const client = await connectRuntime(
    options.daemonHome,
    instance.listen,
    options.clientId,
    options.timeoutMs ?? 60_000,
  );
  try {
    const info = await verifyRuntimeHandshake(options.daemonHome, manifest, instance, client);
    options.assertOwned();
    return {
      instance,
      client,
      manifest,
      info,
      entryHashes: Object.fromEntries(
        manifest.files
          .filter(
            (file) => file.kind === "file" && Object.values(manifest.entries).includes(file.path),
          )
          .map((file) => [file.path, file.kind === "file" ? file.sha256 : ""]),
      ),
      async stop() {
        try {
          await stopRuntimeInstance({ ...options, instance });
        } finally {
          await client.close();
        }
      },
    };
  } catch (error) {
    await client.close();
    throw error;
  }
}

// Expected ownership must come from the durable instance ledger, not a newly
// observed pid-lock. A failed attach never stops the process it was inspecting.
export async function attachRuntime(options: RuntimeAttachOptions) {
  const { manifest } = await verifyRuntimeSlot(options);
  const live = await readDaemonInstance(options.daemonHome);
  if (!live || !isSameDaemonInstance(live, options.expected))
    throw new StorageError(
      "state_conflict",
      "Existing runtime does not match the recorded instance",
    );
  const ready = await waitForDaemonReady(options.daemonHome, {
    instance: options.expected,
    timeoutMs: options.timeoutMs ?? 60_000,
  });
  return connectRuntimeHandle(options, manifest, ready);
}

// Its caller holds the control lease for the whole returned lifetime.
export async function launchRuntime(options: RuntimeLaunchOptions) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  // daemon-control intentionally leaves a timed-out CLI start alive. An abort
  // deadline instead uses its bounded child cleanup path, even before pid-lock.
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (options.signal) signals.push(options.signal);
  const signal = AbortSignal.any(signals);
  let acquired: DaemonInstance | undefined;
  let recording = Promise.resolve();
  let spawnAttempted = false;

  try {
    const { slot, entries, manifest } = await verifyRuntimeSlot(options);
    if (await readDaemonInstance(options.daemonHome))
      throw new StorageError(
        "state_conflict",
        "Refusing to launch over an existing daemon instance",
      );
    options.assertOwned();
    spawnAttempted = true;
    const started = await startDaemonInstance({
      home: options.daemonHome,
      command: process.execPath,
      args: [entries.supervisor],
      mode: "deployment",
      signal,
      timeoutMs: timeoutMs + 5000,
      env: {
        ...isolateRuntimeNodeEnvironment(options.environment),
        MALLEAF_DAEMON_HOME: options.daemonHome,
        MALLEAF_SLOT_MANIFEST: path.join(slot, "malleaf.json"),
      },
      onAcquired(instance) {
        acquired = instance;
        recording = options.recordInstance?.(instance) ?? Promise.resolve();
        // Awaited before accepting readiness; handle rejection while startup runs.
        void recording.catch(() => undefined);
      },
    });
    if (!started.spawned)
      throw new StorageError("state_conflict", "Another daemon acquired this home during launch");
    await recording;
    const instance = await waitForDaemonReady(options.daemonHome, {
      instance: started.instance,
      signal,
      timeoutMs,
    });
    return await connectRuntimeHandle(options, manifest, instance);
  } catch (error) {
    // No outstanding ledger write may race a caller clearing a failed launch.
    await recording.catch(() => undefined);
    let cleanup: "verified" | "unverified" =
      !spawnAttempted ||
      (error instanceof DaemonInstanceError && error.code === "DAEMON_START_FAILED")
        ? "verified"
        : "unverified";
    if (acquired) {
      try {
        await stopRuntimeInstance({ ...options, instance: acquired });
        cleanup = "verified";
      } catch (cleanupError) {
        // AggregateError retains both failures; its options are the third argument.
        // oxlint-disable-next-line preserve-caught-error
        throw new RuntimeLaunchError(
          "unverified",
          new AggregateError(
            [error, cleanupError],
            "Runtime launch failed and its stop could not be confirmed",
            { cause: cleanupError },
          ),
          acquired,
        );
      }
    }
    throw new RuntimeLaunchError(cleanup, error, acquired);
  }
}

export type RuntimeHandle = Awaited<ReturnType<typeof launchRuntime>>;
