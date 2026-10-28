import {
  getDesktopDaemonStatus,
  shouldUseDesktopDaemon,
  startDesktopDaemon,
  type DesktopDaemonStatus,
} from "@/desktop/daemon/desktop-daemon";
import {
  connectionFromListen,
  hostConnectionEquals,
  MALLEAF_CONTROLLER_CONNECTION_ID,
} from "@/types/host-connection";
import type { HostRuntimeStore } from "@/runtime/host-runtime";

export type DaemonStartResult = { ok: true } | { ok: false; error: string };
export type DaemonStartCondition = boolean | (() => boolean | Promise<boolean>);

export interface StartDaemonIfEnabledInput {
  shouldStart: DaemonStartCondition;
}

type DaemonConnectionStore = Pick<HostRuntimeStore, "getHosts" | "upsertConnectionFromListen"> &
  Partial<Pick<HostRuntimeStore, "boot">>;

export interface DaemonStartServiceDeps {
  store: DaemonConnectionStore;
  startDesktopDaemon?: () => Promise<DesktopDaemonStatus>;
  getDesktopDaemonStatus?: () => Promise<DesktopDaemonStatus | null>;
}

export async function upsertDesktopDaemonConnection(
  store: DaemonConnectionStore,
  daemon: DesktopDaemonStatus,
): Promise<DaemonStartResult> {
  const serverId = daemon.serverId.trim();
  if (!serverId) {
    return { ok: false, error: "Desktop daemon did not return a server id." };
  }
  const existing = store.getHosts().find((host) => host.serverId === serverId);
  if (existing && daemon.ownership !== "controller") {
    return { ok: true };
  }
  const listenAddress = daemon.listen?.trim() ?? "";
  if (!listenAddress) {
    return { ok: false, error: "Desktop daemon did not return a listen address." };
  }
  const connection = connectionFromListen(listenAddress);
  if (!connection) {
    return {
      ok: false,
      error: `Desktop daemon returned an unsupported listen address: ${listenAddress}`,
    };
  }
  if (
    daemon.ownership === "controller" &&
    existing?.connections.some(
      (current) =>
        current.id === MALLEAF_CONTROLLER_CONNECTION_ID &&
        hostConnectionEquals(current, { ...connection, id: MALLEAF_CONTROLLER_CONNECTION_ID }),
    )
  )
    return { ok: true };
  await store.upsertConnectionFromListen({
    listenAddress,
    serverId,
    hostname: daemon.hostname,
    ...(daemon.ownership === "controller" ? { managedByController: true } : {}),
  });
  return { ok: true };
}

export class DaemonStartService {
  private readonly store: DaemonConnectionStore;
  private readonly invokeStartDesktopDaemon: () => Promise<DesktopDaemonStatus>;
  private readonly readDesktopStatus: () => Promise<DesktopDaemonStatus | null>;
  private readonly listeners = new Set<() => void>();
  private lastError: string | null = null;
  private readonly attachedEndpoints = new Map<string, string>();
  private inFlightCount = 0;

  constructor(deps: DaemonStartServiceDeps) {
    this.store = deps.store;
    this.readDesktopStatus =
      deps.getDesktopDaemonStatus ??
      (async () => (shouldUseDesktopDaemon() ? getDesktopDaemonStatus() : null));
    this.invokeStartDesktopDaemon = deps.startDesktopDaemon ?? startDesktopDaemon;
  }

  async refreshAttachment(): Promise<DesktopDaemonStatus | null> {
    await this.store.boot?.();
    const status = await this.readDesktopStatus();
    if (status?.ownership === "controller" && status.status === "running") {
      const previous = this.attachedEndpoints.get(status.serverId);
      const host = this.store.getHosts().find((entry) => entry.serverId === status.serverId);
      // Do not undo a user's removal or connection preference on every poll.
      if (previous === status.listen || (previous && !host)) return status;
      const result = await upsertDesktopDaemonConnection(this.store, status);
      if (result.ok && status.listen) this.attachedEndpoints.set(status.serverId, status.listen);
      this.setLastError(result.ok ? null : result.error);
    }
    if (status?.ownership === "controller" && status.status !== "running")
      this.setLastError(status.error);
    return status;
  }

  async start(): Promise<DaemonStartResult> {
    return this.startIfEnabled({ shouldStart: true });
  }

  async startIfEnabled(input: StartDaemonIfEnabledInput): Promise<DaemonStartResult> {
    // Settings evaluation is part of startup. Publish the running state before
    // its first await so restored app chrome cannot appear between these phases.
    this.beginRequest();
    try {
      const selected = await this.refreshAttachment();
      if (selected?.ownership === "controller") {
        return selected.error ? this.fail(selected.error) : { ok: true };
      }
      let shouldStart: boolean;
      try {
        shouldStart =
          typeof input.shouldStart === "boolean" ? input.shouldStart : await input.shouldStart();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return this.fail(`Failed to evaluate desktop daemon settings: ${message}`);
      }

      if (!shouldStart) {
        return { ok: true };
      }

      const daemon = await this.invokeStartDesktopDaemon();
      const result = await upsertDesktopDaemonConnection(this.store, daemon);
      return result.ok ? result : this.fail(result.error);
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : String(error));
    } finally {
      this.endRequest();
    }
  }

  getLastError(): string | null {
    return this.lastError;
  }

  isRunning(): boolean {
    return this.inFlightCount > 0;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private fail(message: string): DaemonStartResult {
    this.setLastError(message);
    return { ok: false, error: message };
  }

  private setLastError(value: string | null): void {
    if (this.lastError === value) {
      return;
    }
    this.lastError = value;
    this.notify();
  }

  private beginRequest(): void {
    const becameRunning = this.inFlightCount === 0;
    this.inFlightCount += 1;
    const errorChanged = this.lastError !== null;
    this.lastError = null;
    if (becameRunning || errorChanged) {
      this.notify();
    }
  }

  private endRequest(): void {
    this.inFlightCount = Math.max(0, this.inFlightCount - 1);
    if (this.inFlightCount === 0) {
      this.notify();
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

let singletonDaemonStartService: DaemonStartService | null = null;
const DAEMON_START_SERVICE_GLOBAL_KEY = "__paseoDaemonStartService";

type DaemonStartServiceGlobal = typeof globalThis & {
  [DAEMON_START_SERVICE_GLOBAL_KEY]?: DaemonStartService;
};

export function getDaemonStartService(deps: DaemonStartServiceDeps): DaemonStartService {
  if (singletonDaemonStartService) {
    return singletonDaemonStartService;
  }

  const runtimeGlobal = globalThis as DaemonStartServiceGlobal;
  if (runtimeGlobal[DAEMON_START_SERVICE_GLOBAL_KEY]) {
    singletonDaemonStartService = runtimeGlobal[DAEMON_START_SERVICE_GLOBAL_KEY] ?? null;
    if (singletonDaemonStartService) {
      return singletonDaemonStartService;
    }
  }

  singletonDaemonStartService = new DaemonStartService(deps);
  runtimeGlobal[DAEMON_START_SERVICE_GLOBAL_KEY] = singletonDaemonStartService;
  return singletonDaemonStartService;
}
