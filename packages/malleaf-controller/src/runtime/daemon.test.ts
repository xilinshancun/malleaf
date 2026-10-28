import { randomBytes } from "node:crypto";
import { publishRuntimeAuthority } from "./authority.js";
const calls = vi.hoisted(() => ({ shutdown: vi.fn(async () => {}), stop: vi.fn() }));
vi.mock("@getpaseo/client/node", () => ({
  createHostClient: () => ({
    connect: async () => {},
    close: async () => {},
    shutdownServer: calls.shutdown,
  }),
}));
vi.mock("@getpaseo/server/daemon-control", async (original) => ({
  ...(await original<typeof import("@getpaseo/server/daemon-control")>()),
  readDaemonInstance: async () => null,
  stopDaemonInstance: async (
    _home: string,
    options: { instance: object; requestShutdown(ready: { listen: string }): Promise<void> },
  ) => {
    calls.stop(options.instance);
    // Exercise the public shutdown callback used on Windows on every platform.
    await options.requestShutdown({ listen: "127.0.0.1:1" });
  },
}));
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { assertSlotDependencyBoundary, stopRuntimeInstance } from "./daemon.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("a missing slot dependency cannot fall back to a poisoned ancestor node_modules", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "slot-boundary-test-")));
  roots.push(root);
  const slot = path.join(root, "product", "versions", "a".repeat(64));
  await mkdir(slot, { recursive: true });
  await expect(assertSlotDependencyBoundary(slot)).resolves.toBeUndefined();
  const poison = path.join(root, "node_modules", "zod");
  await mkdir(poison, { recursive: true });
  await writeFile(
    path.join(poison, "index.js"),
    "throw new Error('borrowed code from outside slot');",
  );
  await expect(assertSlotDependencyBoundary(slot)).rejects.toThrow(
    "ancestor contains node_modules",
  );
});

test("the exact-instance stop callback carries controller authority even before drain commit", async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "authority-stop-test-")));
  roots.push(home);
  const controllerToken = randomBytes(32).toString("hex");
  await publishRuntimeAuthority(home, controllerToken, () => {});
  const instance = {
    pid: 123,
    startedAt: new Date().toISOString(),
    hostname: "test",
    uid: 1,
    listen: "127.0.0.1:1",
  };
  const options = {
    daemonHome: home,
    clientId: "controller",
    assertOwned() {},
    instance,
    controllerToken,
  };
  await stopRuntimeInstance(options);
  expect(calls.stop).toHaveBeenLastCalledWith(instance);
  expect(calls.shutdown).toHaveBeenLastCalledWith({ timeout: 5000, controllerToken });
  calls.stop.mockClear();
  await expect(
    stopRuntimeInstance({ ...options, controllerToken: randomBytes(32).toString("hex") }),
  ).rejects.toThrow("changed");
  expect(calls.stop).not.toHaveBeenCalled();
});
