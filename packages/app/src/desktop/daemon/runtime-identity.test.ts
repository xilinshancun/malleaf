import { expect, test } from "vitest";
import { matchesDesktopRuntimeIdentity } from "./runtime-identity";
import type { DesktopDaemonStatus } from "./desktop-daemon";
import { toDaemonServerInfo, useSessionStore } from "@/stores/session-store";
import type { ServerInfoStatusPayload } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const selection = {
  serverId: "local",
  ownership: "controller",
  expectedBuildId: "a".repeat(64),
} as DesktopDaemonStatus;
const malleaf = {
  product: "malleaf",
  display: "test",
  buildId: selection.expectedBuildId!,
  upstream: "test",
};
test("only the selected controller build is treated as local", () => {
  expect(matchesDesktopRuntimeIdentity(selection, "local", { serverId: "local", malleaf })).toBe(
    true,
  );
  expect(matchesDesktopRuntimeIdentity(selection, "local", undefined)).toBe(false);
  expect(matchesDesktopRuntimeIdentity(selection, "local", { serverId: "local" })).toBe(false);
  expect(
    matchesDesktopRuntimeIdentity(selection, "local", {
      serverId: "local",
      malleaf: { ...malleaf, buildId: "b".repeat(64) },
    }),
  ).toBe(false);
  expect(matchesDesktopRuntimeIdentity(selection, "remote", { serverId: "local", malleaf })).toBe(
    false,
  );
  expect(
    matchesDesktopRuntimeIdentity({ ...selection, ownership: "desktop" }, "local", undefined),
  ).toBe(true);
});
test("handshake projection retains a changed build with the same upstream version", () => {
  const store = useSessionStore.getState();
  store.initializeSession("local", {} as DaemonClient);
  try {
    const hello = { serverId: "local", version: "1", malleaf } as ServerInfoStatusPayload;
    store.updateSessionServerInfo("local", toDaemonServerInfo(hello));
    expect(useSessionStore.getState().sessions.local?.serverInfo?.malleaf).toEqual(malleaf);
    store.updateSessionServerInfo(
      "local",
      toDaemonServerInfo({ ...hello, malleaf: { ...malleaf, buildId: "b".repeat(64) } }),
    );
    expect(useSessionStore.getState().sessions.local?.serverInfo?.malleaf?.buildId).toBe(
      "b".repeat(64),
    );
  } finally {
    store.clearSession("local");
  }
});
