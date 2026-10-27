import path from "node:path";
import os from "node:os";
import { mkdirSync } from "node:fs";

export function getIsolatedDaemonOsHome(): string {
  const home = process.env.E2E_DAEMON_OS_HOME;
  if (!home) throw new Error("E2E_DAEMON_OS_HOME is required for daemon home fixtures");
  return home;
}

// Both current Malleaf and published upstream fixtures must stay within the
// disposable OS home, including provider integrations that ignore daemon home.
export function isolatedDaemonEnvironment(
  osHome: string,
  daemonHome: string,
  options: Partial<NodeJS.ProcessEnv> = {},
  useHostHarness = false,
): NodeJS.ProcessEnv {
  const codexHome = path.join(osHome, ".codex");
  const claudeHome = path.join(osHome, ".claude");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(claudeHome, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV,
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("PASEO_") && !key.startsWith("MALLEAF_"),
      ),
    ),
  };
  Object.assign(env, options, {
    HOME: osHome,
    USERPROFILE: osHome,
    CODEX_HOME:
      options.CODEX_HOME ??
      (useHostHarness ? (process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")) : codexHome),
    CLAUDE_CONFIG_DIR:
      options.CLAUDE_CONFIG_DIR ??
      (useHostHarness
        ? (process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"))
        : claudeHome),
    MALLEAF_HOME: path.join(osHome, ".malleaf"),
    MALLEAF_DAEMON_HOME: daemonHome,
    MALLEAF_TEST: "1",
  });
  // Explicit fixture aliases support tests against a published upstream daemon.
  // Malleaf's boundary discards these and regenerates them from MALLEAF_*.
  env.PASEO_HOME = daemonHome;
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("MALLEAF_") && key !== "MALLEAF_HOME" && key !== "MALLEAF_DAEMON_HOME") {
      env[key.replace(/^MALLEAF_/, "PASEO_")] = value;
    }
  }
  return env;
}
