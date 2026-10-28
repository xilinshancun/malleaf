import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_DESKTOP_SETTINGS } from "../settings/desktop-settings";
import { createDaemonCommandHandlers } from "./daemon-manager";

const mocks = vi.hoisted(() => ({
  paseoHome: "",
  settings: {
    releaseChannel: "stable",
    daemon: {
      manageBuiltInDaemon: true,
      keepRunningAfterQuit: true,
    },
  },
  runExternalCliJsonCommand: vi.fn(),
  runExternalCliTextCommand: vi.fn(),
  createNodeEntrypointInvocation: vi.fn(() => ({
    command: "node",
    args: [],
    env: {},
  })),
  spawnProcess: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  appLogPath: "",
  getElectronLogFile: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => mocks.paseoHome),
    getVersion: vi.fn(() => "1.2.3"),
    isPackaged: true,
  },
  ipcMain: { handle: vi.fn() },
  powerMonitor: { getSystemIdleTime: vi.fn(() => 0) },
}));

vi.mock("electron-log/main", () => ({
  default: {
    info: mocks.logInfo,
    error: mocks.logError,
    transports: {
      file: {
        getFile: mocks.getElectronLogFile,
      },
    },
  },
}));

vi.mock("@getpaseo/server/daemon-control", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolvePaseoHome: () => mocks.paseoHome,
  spawnProcess: mocks.spawnProcess,
}));

vi.mock("../settings/desktop-settings-electron.js", () => ({
  getDesktopSettingsStore: () => ({
    get: async () => mocks.settings,
    patch: vi.fn(),
    migrateLegacyRendererSettings: vi.fn(),
  }),
}));

vi.mock("./runtime-paths.js", () => ({
  createNodeEntrypointInvocation: mocks.createNodeEntrypointInvocation,
  resolveDaemonRunnerEntrypoint: vi.fn(() => ({
    entryPath: path.join(mocks.paseoHome, "daemon.js"),
    execArgv: [],
  })),
}));

vi.mock("./cli/external.js", () => ({
  runExternalCliJsonCommand: mocks.runExternalCliJsonCommand,
  runExternalCliTextCommand: mocks.runExternalCliTextCommand,
}));

describe("daemon-manager commands", () => {
  let fixtureRoot: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "paseo daemon manager "));
    mocks.paseoHome = path.join(fixtureRoot, "home");
    vi.stubEnv("MALLEAF_HOME", fixtureRoot);
    vi.stubEnv("MALLEAF_DAEMON_HOME", mocks.paseoHome);
    mocks.appLogPath = path.join(fixtureRoot, "main.log");
    mocks.settings = DEFAULT_DESKTOP_SETTINGS;
    mocks.runExternalCliJsonCommand.mockReset();
    mocks.runExternalCliTextCommand.mockReset();
    mocks.createNodeEntrypointInvocation.mockReset();
    mocks.createNodeEntrypointInvocation.mockReturnValue({ command: "node", args: [], env: {} });
    mocks.spawnProcess.mockReset();
    mocks.logInfo.mockReset();
    mocks.logError.mockReset();
    mocks.getElectronLogFile.mockReset();
    mocks.getElectronLogFile.mockReturnValue({ path: mocks.appLogPath });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("returns the Electron main-process log tail from electron-log", () => {
    writeFileSync(
      mocks.appLogPath,
      Array.from({ length: 105 }, (_value, index) => `main log line ${index + 1}`).join("\n"),
    );
    const handlers = createDaemonCommandHandlers();

    expect(handlers.desktop_app_logs()).toEqual({
      logPath: mocks.appLogPath,
      contents: Array.from({ length: 100 }, (_value, index) => `main log line ${index + 6}`).join(
        "\n",
      ),
    });
  });

  it("exposes updater diagnostics through the desktop command boundary", () => {
    const diagnostics = createDaemonCommandHandlers().desktop_update_diagnostics();

    expect(diagnostics).toMatchObject({
      platform: process.platform,
      currentVersion: "1.2.3",
    });
  });

  it("reports a stopped daemon without launching the CLI when no local daemon runs", async () => {
    mkdirSync(mocks.paseoHome);
    writeFileSync(path.join(mocks.paseoHome, "server-id"), "srv_existing\n");
    mocks.runExternalCliJsonCommand.mockResolvedValue({
      home: mocks.paseoHome,
      pid: null,
      startedAt: null,
      listen: null,
      hostname: null,
      localDaemon: "stopped",
      desktopManaged: false,
      connectedDaemon: "not_probed",
    });

    const status = await createDaemonCommandHandlers().desktop_daemon_status();

    expect(status).toMatchObject({ serverId: "", status: "stopped", pid: null });
    expect(mocks.runExternalCliJsonCommand).not.toHaveBeenCalled();
  });

  it("reports an errored daemon when the local daemon state cannot be read", async () => {
    mkdirSync(mocks.paseoHome);
    writeFileSync(path.join(mocks.paseoHome, "paseo.pid"), "garbage");

    const status = await createDaemonCommandHandlers().desktop_daemon_status();

    expect(status).toMatchObject({ serverId: "", status: "errored", pid: null });
    expect(status.error).toBeTruthy();
  });

  it("returns a local credential only for its live managed daemon listen", async () => {
    mkdirSync(mocks.paseoHome);
    const token = "a".repeat(43);
    writeFileSync(path.join(mocks.paseoHome, "local-credential"), `${token}\n`, { mode: 0o600 });
    const lock = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostname: hostname(),
      uid: process.getuid?.() ?? 0,
      listen: "127.0.0.1:6799",
      desktopManaged: true,
    };
    const lockPath = path.join(mocks.paseoHome, "paseo.pid");
    writeFileSync(lockPath, JSON.stringify(lock));
    const handler = createDaemonCommandHandlers().desktop_local_credential;
    expect(await handler({ listen: "localhost:6799" })).toBe(token);
    expect(await handler({ listen: "remote:6799" })).toBeNull();
    writeFileSync(lockPath, JSON.stringify({ ...lock, desktopManaged: false }));
    expect(await handler({ listen: "localhost:6799" })).toBeNull();
  });
  function controllerPointer(corrupt = false) {
    mkdirSync(path.join(fixtureRoot, "runner"), { recursive: true });
    mkdirSync(path.join(fixtureRoot, "data/current"), { recursive: true });
    writeFileSync(
      path.join(fixtureRoot, "runner/current.json"),
      corrupt
        ? "{"
        : JSON.stringify({
            schemaVersion: 1,
            minReaderVersion: 1,
            current: { buildId: "a".repeat(64), dataId: "current" },
            trial: null,
          }),
    );
  }

  it.each([false, true])(
    "never starts a daemon for a controller pointer, including corrupt=%s",
    async (corrupt) => {
      controllerPointer(corrupt);
      const handlers = createDaemonCommandHandlers();
      const status = await handlers.start_desktop_daemon();
      expect(status).toMatchObject({
        ownership: "controller",
        status: corrupt ? "errored" : "stopped",
        ownedByDesktop: false,
      });
      expect(mocks.createNodeEntrypointInvocation).not.toHaveBeenCalled();
      expect(mocks.runExternalCliJsonCommand).not.toHaveBeenCalled();
    },
  );

  it("reads controller credentials and status from the selected epoch without a CLI probe", async () => {
    controllerPointer();
    const home = path.join(fixtureRoot, "data/current");
    const token = "c".repeat(43);
    writeFileSync(path.join(home, "local-credential"), token);
    writeFileSync(
      path.join(home, "paseo.pid"),
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        hostname: hostname(),
        uid: process.getuid?.() ?? 0,
        listen: "127.0.0.1:6799",
        serverId: "controller-server",
        desktopManaged: false,
      }),
    );
    const handlers = createDaemonCommandHandlers();
    await expect(handlers.start_desktop_daemon()).resolves.toMatchObject({
      ownership: "controller",
      status: "running",
      serverId: "controller-server",
      pid: process.pid,
      expectedBuildId: "a".repeat(64),
      dataId: "current",
      ownedByDesktop: false,
    });
    await expect(handlers.desktop_local_credential({ listen: "localhost:6799" })).resolves.toBe(
      token,
    );
    await expect(handlers.desktop_local_credential({ listen: "remote:6799" })).resolves.toBeNull();
    expect(mocks.runExternalCliJsonCommand).not.toHaveBeenCalled();
    expect(JSON.parse(await handlers.cli_daemon_status())).toMatchObject({
      ownership: "controller",
      pid: process.pid,
    });
    expect(mocks.runExternalCliTextCommand).not.toHaveBeenCalled();
  });

  it("controller ownership blocks explicit lifecycle commands while quit/update leave it alone", async () => {
    controllerPointer();
    const handlers = createDaemonCommandHandlers();
    await expect(handlers.restart_desktop_daemon()).rejects.toThrow(/Malleaf controller/);
    await expect(handlers.stop_desktop_daemon({ reason: "manual_ipc" })).rejects.toThrow(
      /Malleaf controller/,
    );
    for (const reason of ["quit", "app_update", "version_mismatch"]) {
      await expect(handlers.stop_desktop_daemon({ reason })).resolves.toMatchObject({
        ownership: "controller",
        status: "stopped",
      });
    }
    expect(mocks.runExternalCliJsonCommand).not.toHaveBeenCalled();
  });
});
