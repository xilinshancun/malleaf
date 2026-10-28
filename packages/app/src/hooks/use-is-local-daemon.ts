import { useQuery } from "@tanstack/react-query";
import { shouldUseDesktopDaemon, type DesktopDaemonStatus } from "@/desktop/daemon/desktop-daemon";

import { getDaemonStartService } from "@/runtime/daemon-start-service";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { matchesDesktopRuntimeIdentity } from "@/desktop/daemon/runtime-identity";

const DESKTOP_DAEMON_SERVER_ID_QUERY_KEY = ["desktop-daemon-server-id"] as const;

interface DesktopDaemonServerIdResult {
  serverId: string | null;
  selection: DesktopDaemonStatus | null;
}

async function loadDesktopDaemonServerId(): Promise<DesktopDaemonServerIdResult> {
  const status = await getDaemonStartService({ store: getHostRuntimeStore() }).refreshAttachment();
  const serverId = status?.serverId.trim() ?? "";
  return {
    serverId: serverId.length > 0 ? serverId : null,
    selection: status,
  };
}

function useLocalDaemonServerIdQuery() {
  const isDesktopApp = shouldUseDesktopDaemon();

  return useQuery({
    queryKey: DESKTOP_DAEMON_SERVER_ID_QUERY_KEY,
    queryFn: loadDesktopDaemonServerId,
    enabled: isDesktopApp,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchInterval: (activeQuery) => {
      if (activeQuery.state.data?.selection?.ownership === "controller") return 2000;
      return activeQuery.state.data?.serverId ? false : 1000;
    },
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function useLocalDaemonServerId(): string | null {
  const isDesktopApp = shouldUseDesktopDaemon();
  const query = useLocalDaemonServerIdQuery();

  if (!isDesktopApp) {
    return null;
  }

  return query.data?.serverId ?? null;
}

export type LocalDaemonServerIdState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "resolved"; serverId: string | null };

export function useLocalDaemonServerIdState(): LocalDaemonServerIdState {
  const isDesktopApp = shouldUseDesktopDaemon();
  const query = useLocalDaemonServerIdQuery();

  if (!isDesktopApp) {
    return { status: "resolved", serverId: null };
  }
  if (query.isError) {
    return { status: "error" };
  }
  if (query.isSuccess) {
    return { status: "resolved", serverId: query.data.serverId };
  }
  return { status: "loading" };
}

export function useDesktopRuntimeSelection(): DesktopDaemonStatus | null {
  return useLocalDaemonServerIdQuery().data?.selection ?? null;
}

export function useIsLocalDaemon(serverId: string): boolean {
  const selection = useDesktopRuntimeSelection();
  const info = useSessionStore((state) => state.sessions[serverId]?.serverInfo);
  return matchesDesktopRuntimeIdentity(selection, serverId, info);
}
