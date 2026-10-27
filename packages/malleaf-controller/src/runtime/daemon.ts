import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createHostClient } from "@getpaseo/client/node";
import {
  type DaemonInstance,
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

export async function assertSlotDependencyBoundary(slot: string): Promise<void> {
  // Node walks every ancestor when a dependency is absent from the slot. Refuse
  // that layout instead of allowing an incomplete trace to borrow host code.
  for (let parent = path.dirname(slot); ; parent = path.dirname(parent)) {
    if (await exists(path.join(parent, "node_modules")))
      throw new StorageError("unsafe_path", `Slot ancestor contains node_modules: ${parent}`);
    if (path.dirname(parent) === parent) break;
  }
}

interface RuntimeLaunchOptions {
  slotDirectory: string;
  buildId: string;
  daemonHome: string;
  environment: NodeJS.ProcessEnv;
  clientId: string;
  assertOwned(): void;
  recordInstance?(instance: DaemonInstance): Promise<void>;
  timeoutMs?: number;
  signal?: AbortSignal;
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

// This adapter never attaches to an unidentified process or silently forces a
// stop. Its caller holds the controller lease for the entire returned lifetime.
export async function launchRuntime(options: RuntimeLaunchOptions) {
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
  if (await readDaemonInstance(options.daemonHome))
    throw new StorageError("state_conflict", "Refusing to launch over an existing daemon instance");
  const timeoutMs = options.timeoutMs ?? 60_000;
  // daemon-control intentionally leaves a timed-out CLI start alive. An abort
  // deadline instead uses its bounded child cleanup path, even before pid-lock.
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (options.signal) signals.push(options.signal);
  const signal = AbortSignal.any(signals);
  let acquired: DaemonInstance | undefined;
  let recording = Promise.resolve();
  let client: Awaited<ReturnType<typeof connectRuntime>> | undefined;

  async function stop(instance: DaemonInstance): Promise<void> {
    options.assertOwned();
    await stopDaemonInstance(options.daemonHome, {
      instance,
      timeoutMs: 15_000,
      requestShutdown: async (ready) => {
        const shutdownClient = await connectRuntime(
          options.daemonHome,
          ready.listen,
          options.clientId,
          5000,
        );
        try {
          await shutdownClient.shutdownServer({ timeout: 5000 });
        } finally {
          await shutdownClient.close();
        }
      },
    });
    if (await readDaemonInstance(options.daemonHome))
      throw new StorageError("state_conflict", "Daemon stop did not leave an empty runtime home");
  }

  try {
    options.assertOwned();
    const started = await startDaemonInstance({
      home: options.daemonHome,
      command: process.execPath,
      args: [entries.supervisor],
      mode: "deployment",
      signal,
      timeoutMs: timeoutMs + 5000,
      env: {
        ...options.environment,
        NODE_PATH: "",
        NODE_OPTIONS: "--no-global-search-paths",
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
    options.assertOwned();
    client = await connectRuntime(options.daemonHome, instance.listen, options.clientId, timeoutMs);
    const info = await verifyRuntimeHandshake(options.daemonHome, manifest, instance, client);
    options.assertOwned();
    const connected = client;
    return {
      instance,
      client: connected,
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
          await stop(instance);
        } finally {
          await connected.close();
        }
      },
    };
  } catch (error) {
    await client?.close();
    if (acquired) {
      try {
        await stop(acquired);
      } catch (cleanupError) {
        // AggregateError retains both failures; its options are the third argument.
        // oxlint-disable-next-line preserve-caught-error
        throw new AggregateError(
          [error, cleanupError],
          "Runtime launch failed and its stop could not be confirmed",
          { cause: cleanupError },
        );
      }
    }
    throw error;
  }
}
