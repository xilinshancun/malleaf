import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm, readFile, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "playwright/test";
import { BUILTIN_PROVIDER_IDS } from "@getpaseo/protocol/provider-manifest";
import { createHostClient } from "@getpaseo/client/node";
import { savePersistedConfig } from "@getpaseo/server/configuration";
import {
  startDaemonInstance,
  stopDaemonInstance,
  readDaemonInstance,
  readLocalCredentialForTarget,
} from "@getpaseo/server/daemon-control";

async function electronHostMetadata() {
  if (process.platform !== "darwin") return null;
  const library = path.join(os.userInfo().homedir, "Library");
  const names = [
    "Logs/Electron",
    "Application Support/Electron",
    "Preferences/com.github.Electron.plist",
    "Caches/Electron",
  ];
  return Promise.all(
    names.map(async (name) => {
      try {
        const info = await lstat(path.join(library, name));
        return { name, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
      } catch (error) {
        if (error.code === "ENOENT") return { name, absent: true };
        throw error;
      }
    }),
  );
}

// Main-process ownership acceptance. No controller activation and no installed home.
export async function verifyControllerOwnedDesktop() {
  const hostBefore = await electronHostMetadata();
  const repo = fileURLToPath(new URL("../../..", import.meta.url));
  const root = await mkdtemp(path.join(os.tmpdir(), "malleaf-desktop-ownership-"));
  const home = path.join(root, "product");
  const epoch = path.join(home, "data/current");
  const osHome = path.join(root, "os-home");
  const temp = path.join(root, "tmp");
  for (const dir of [epoch, osHome, temp, path.join(home, "runner")])
    await mkdir(dir, { recursive: true });
  const env = {};
  for (const name of [
    "SystemRoot",
    "ComSpec",
    "WINDIR",
    "LANG",
    "LC_ALL",
    "DISPLAY",
    "XAUTHORITY",
  ]) {
    const key = Object.keys(process.env).find(
      (entry) => entry.toLowerCase() === name.toLowerCase(),
    );
    if (key) env[name] = process.env[key];
  }
  const systemPaths =
    process.platform === "win32"
      ? [path.join(env.SystemRoot ?? "C:\\Windows", "System32")]
      : ["/usr/bin", "/bin"];
  Object.assign(env, {
    PATH: [path.dirname(process.execPath), ...systemPaths].join(path.delimiter),
    HOME: osHome,
    USERPROFILE: osHome,
    APPDATA: path.join(osHome, "AppData"),
    LOCALAPPDATA: path.join(osHome, "AppData"),
    XDG_CONFIG_HOME: path.join(osHome, ".config"),
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    CODEX_HOME: path.join(osHome, ".codex"),
    CLAUDE_CONFIG_DIR: path.join(osHome, ".claude"),
    MALLEAF_HOME: home,
    MALLEAF_DAEMON_HOME: path.join(home, "daemon"),
    MALLEAF_TEST: "1",
    MALLEAF_NODE_ENV: "production",
    MALLEAF_LISTEN: "127.0.0.1:0",
    MALLEAF_WEB_UI_ENABLED: "false",
    MALLEAF_RELAY_ENABLED: "false",
    MALLEAF_LOCAL_SPEECH_AUTO_DOWNLOAD: "false",
  });
  savePersistedConfig(epoch, {
    daemon: {
      listen: "127.0.0.1:0",
      relay: { enabled: false },
      enableTerminalAgentHooks: false,
      serviceProxy: { enabled: false },
    },
    agents: {
      providers: Object.fromEntries(BUILTIN_PROVIDER_IDS.map((id) => [id, { enabled: false }])),
    },
    pluginsEnabled: false,
    features: {
      dictation: { enabled: false },
      voiceMode: { enabled: false },
      webUi: { enabled: false },
    },
    worktrees: { root: path.join(root, "worktrees") },
    providers: { local: { modelsDir: path.join(root, "models") } },
  });
  const pointer = {
    schemaVersion: 1,
    minReaderVersion: 1,
    current: { buildId: "a".repeat(64), dataId: "current" },
    trial: null,
  };
  const pointerFile = path.join(home, "runner/current.json");
  await writeFile(pointerFile, JSON.stringify(pointer));
  const main = path.join(root, "main.cjs");
  const electronPaths = Object.fromEntries(
    ["appData", "userData", "logs", "crashDumps", "sessionData", "temp"].map((name) => [
      name,
      path.join(root, `electron-${name}`),
    ]),
  );
  for (const directory of Object.values(electronPaths)) await mkdir(directory, { recursive: true });
  await writeFile(
    main,
    `const { app } = require("electron"); for (const [key, value] of Object.entries(${JSON.stringify(electronPaths)})) app.setPath(key, value); app.whenReady().then(() => { global.lifecycle = require(${JSON.stringify(path.join(repo, "packages/desktop/dist/daemon/daemon-manager.js"))}); });`,
  );

  const instances = [];
  let desktop;
  let succeeded = false;
  const stages = [];
  const command = (name, args) =>
    desktop.evaluate(
      async (_, input) => global.lifecycle.createDaemonCommandHandlers()[input.name](input.args),
      { name, args },
    );
  async function launch(listen) {
    const result = await startDaemonInstance({
      home: epoch,
      command: process.execPath,
      args: [path.join(repo, "packages/server/dist/scripts/supervisor-entrypoint.js")],
      env: { ...env, MALLEAF_LISTEN: listen },
      mode: "deployment",
      signal: AbortSignal.timeout(30_000),
      timeoutMs: 35_000,
      onAcquired: (instance) => {
        instances.push(instance);
      },
    });
    assert.equal(result.spawned, true);
    return result.instance;
  }
  async function stop(instance) {
    await stopDaemonInstance(epoch, {
      instance,
      timeoutMs: 15_000,
      requestShutdown: async (ready) => {
        const client = createHostClient(ready.listen, {
          clientId: "desktop-ownership-acceptance",
          clientType: "cli",
          reconnect: { enabled: false },
          localCredential: () => readLocalCredentialForTarget(epoch, ready.listen) ?? undefined,
        });
        try {
          await client.connect();
          await client.shutdownServer();
        } finally {
          await client.close();
        }
      },
    });
    assert.equal(await readDaemonInstance(epoch), null);
  }
  try {
    desktop = await electron.launch({
      args: [
        "--no-sandbox",
        "--ozone-platform=headless",
        `--user-data-dir=${electronPaths.userData}`,
        main,
      ],
      env,
    });
    await expect
      .poll(() => desktop.evaluate(() => Boolean(global.lifecycle)), { timeout: 10_000 })
      .toBe(true);
    const first = await launch("127.0.0.1:0");
    const attached = await command("start_desktop_daemon");
    assert.equal(attached.ownership, "controller");
    assert.equal(attached.expectedBuildId, pointer.current.buildId);
    assert.equal(attached.pid, first.pid);
    assert.equal(attached.ownedByDesktop, false);
    assert.equal(attached.desktopManaged, false);
    const credential = await command("desktop_local_credential", { listen: first.listen });
    assert.equal(credential, (await readFile(path.join(epoch, "local-credential"), "utf8")).trim());
    for (const reason of ["quit", "app_update", "version_mismatch"]) {
      assert.equal((await command("stop_desktop_daemon", { reason })).pid, first.pid);
    }
    for (const reason of ["manual_ipc", "settings", "host_remove", "restart"]) {
      await assert.rejects(command("stop_desktop_daemon", { reason }), /Malleaf controller/);
    }
    await assert.rejects(command("restart_desktop_daemon"), /Malleaf controller/);
    stages.push({
      stage: "attached",
      pid: attached.pid,
      listen: attached.listen,
      credentialMatched: true,
    });
    await stop(first);
    assert.equal((await command("start_desktop_daemon")).status, "stopped");
    assert.equal(await readDaemonInstance(env.MALLEAF_DAEMON_HOME), null);
    await writeFile(pointerFile, "{");
    assert.equal((await command("start_desktop_daemon")).status, "errored");
    assert.equal(await readDaemonInstance(env.MALLEAF_DAEMON_HOME), null);
    await writeFile(pointerFile, JSON.stringify(pointer));
    const listener = net.createServer();
    await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    assert.notEqual(`127.0.0.1:${port}`, first.listen);
    const second = await launch(`127.0.0.1:${port}`);
    const refreshed = await command("start_desktop_daemon");
    assert.equal(refreshed.pid, second.pid);
    assert.equal(refreshed.listen, second.listen);
    assert.notEqual(refreshed.listen, attached.listen);
    assert.equal(refreshed.serverId, attached.serverId);
    stages.push({
      stage: "new-endpoint",
      pid: refreshed.pid,
      listen: refreshed.listen,
      serverId: refreshed.serverId,
    });
    await stop(second);
    for (const instance of instances)
      assert.throws(() => process.kill(instance.pid, 0), { code: "ESRCH" });
    succeeded = true;
  } finally {
    if (desktop) {
      const exited = once(desktop.process(), "exit");
      await desktop.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await exited;
    }
    // Exact acquired identities only. A replacement is an error, never a target.
    const live = await readDaemonInstance(epoch);
    if (live) {
      const owned = instances.find(
        (instance) => instance.pid === live.pid && instance.startedAt === live.startedAt,
      );
      assert.ok(owned, `Unregistered process; retain ${root}`);
      await stop(owned);
    }
    assert.deepEqual(await electronHostMetadata(), hostBefore, "Electron host metadata changed");
    if (succeeded) await rm(root, { recursive: true, force: true });
    else console.error(`Ownership evidence retained at ${root}`);
  }
  console.log(
    JSON.stringify({
      acceptance: "desktop-controller-ownership",
      stages,
      stopped: true,
      disposed: true,
      electronHostMetadataUnchanged: true,
    }),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await verifyControllerOwnedDesktop();
