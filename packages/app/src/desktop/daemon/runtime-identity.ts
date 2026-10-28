import type { DesktopDaemonStatus } from "./desktop-daemon";
import type { DaemonServerInfo } from "@/stores/session-store";

export function matchesDesktopRuntimeIdentity(
  selection: DesktopDaemonStatus | null,
  serverId: string,
  info: Pick<DaemonServerInfo, "serverId" | "malleaf"> | null | undefined,
): boolean {
  if (!selection?.serverId || selection.serverId !== serverId.trim()) return false;
  if (selection.ownership !== "controller") return true;
  return Boolean(
    selection.expectedBuildId &&
    info?.serverId === selection.serverId &&
    info.malleaf?.buildId === selection.expectedBuildId,
  );
}
