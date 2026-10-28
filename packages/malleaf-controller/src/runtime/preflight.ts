import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BUILTIN_PROVIDER_IDS } from "@getpaseo/protocol/provider-manifest";
import { readPersistedConfig } from "@getpaseo/server/configuration";
import { assertStoragePath } from "../isolation.js";
import { writeJsonAtomic } from "../storage.js";

// Preflight is disposable and deliberately lacks provider credentials. It is
// not the environment used after activating a user's retained data epoch.
export async function preparePreflight(options: {
  slotDirectory: string;
  scratchRoot?: string;
  nodeExecutable?: string;
  mockProvider?: boolean;
  environment?: NodeJS.ProcessEnv;
}) {
  const scratchRoot = options.scratchRoot ?? os.tmpdir();
  assertStoragePath(scratchRoot);
  const root = await realpath(await mkdtemp(path.join(scratchRoot, "malleaf-preflight-")));
  try {
    const osHome = path.join(root, "os-home");
    const home = path.join(root, "product");
    const daemonHome = path.join(home, "daemon");
    const tmp = path.join(root, "tmp");
    const models = path.join(home, "models");
    const worktrees = path.join(home, "worktrees");
    for (const directory of [
      daemonHome,
      tmp,
      models,
      worktrees,
      path.join(osHome, ".codex"),
      path.join(osHome, ".claude"),
      path.join(osHome, "AppData"),
    ]) {
      await mkdir(directory, { recursive: true });
    }
    await writeJsonAtomic({
      filename: path.join(daemonHome, "config.json"),
      mode: "publish",
      value: {
        version: 1,
        daemon: {
          listen: "127.0.0.1:0",
          relay: { enabled: false },
          enableTerminalAgentHooks: false,
          serviceProxy: { enabled: false },
        },
        agents: {
          providers: {
            ...Object.fromEntries(BUILTIN_PROVIDER_IDS.map((id) => [id, { enabled: false }])),
            ...(options.mockProvider
              ? { mock: { enabled: true }, "mock-slow": { enabled: false } }
              : {}),
          },
        },
        pluginsEnabled: false,
        features: {
          dictation: { enabled: false },
          voiceMode: { enabled: false },
          webUi: { enabled: false },
        },
        worktrees: { root: worktrees },
        providers: { local: { modelsDir: models } },
      },
    });
    // Validate through the public configuration parser before any process can
    // consume it. Its legacy TS provider-settings type omits the enabled field.
    readPersistedConfig(daemonHome);
    const inherited = options.environment ?? process.env;
    const env: NodeJS.ProcessEnv = {};
    // Windows environment names are case insensitive, unlike object keys.
    for (const name of ["SystemRoot", "ComSpec", "WINDIR", "LANG", "LC_ALL"]) {
      const key = Object.keys(inherited).find(
        (candidate) => candidate.toLowerCase() === name.toLowerCase(),
      );
      if (key && inherited[key] !== undefined) env[name] = inherited[key];
    }
    const executable = options.nodeExecutable ?? process.execPath;
    const systemPaths =
      process.platform === "win32"
        ? [path.join(env.SystemRoot ?? "C:\\Windows", "System32")]
        : ["/usr/bin", "/bin"];
    Object.assign(env, {
      PATH: [path.dirname(executable), ...systemPaths].join(path.delimiter),
      HOME: osHome,
      USERPROFILE: osHome,
      APPDATA: path.join(osHome, "AppData"),
      LOCALAPPDATA: path.join(osHome, "AppData"),
      XDG_CONFIG_HOME: path.join(osHome, ".config"),
      TMPDIR: tmp,
      TMP: tmp,
      TEMP: tmp,
      CLAUDE_CONFIG_DIR: path.join(osHome, ".claude"),
      CODEX_HOME: path.join(osHome, ".codex"),
      MALLEAF_HOME: home,
      MALLEAF_DAEMON_HOME: daemonHome,
      MALLEAF_SLOT_MANIFEST: path.join(options.slotDirectory, "malleaf.json"),
      MALLEAF_CLI: path.join(options.slotDirectory, "packages/cli/bin/paseo"),
      MALLEAF_LISTEN: "127.0.0.1:0",
      MALLEAF_NODE_ENV: options.mockProvider ? "development" : "production",
      MALLEAF_RELAY_ENABLED: "false",
      MALLEAF_WEB_UI_ENABLED: "false",
      MALLEAF_LOCAL_MODELS_DIR: models,
      MALLEAF_LOCAL_SPEECH_AUTO_DOWNLOAD: "false",
      MALLEAF_TEST: "1",
    });
    return {
      root,
      home,
      daemonHome,
      osHome,
      env,
      // Invoke only after the exact spawned instance has stopped. Failed probes
      // can retain root as diagnostic evidence instead of invoking disposal.
      dispose: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
