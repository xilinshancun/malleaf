import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

// Unit tests import storage without going through a public launcher. A missed
// explicit target must still resolve inside this test file's disposable home.
const home = await mkdtemp(path.join(os.tmpdir(), "malleaf-cli-unit-"));
const daemonHome = path.join(home, ".malleaf", "daemon");
const codexHome = path.join(home, ".codex");
const claudeHome = path.join(home, ".claude");
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PASEO_") || key.startsWith("MALLEAF_")) delete process.env[key];
}
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  MALLEAF_HOME: path.join(home, ".malleaf"),
  MALLEAF_DAEMON_HOME: daemonHome,
  MALLEAF_TEST: "1",
  CODEX_HOME: codexHome,
  CLAUDE_CONFIG_DIR: claudeHome,
  npm_config_cache: path.join(home, ".npm"),
  NPM_CONFIG_CACHE: path.join(home, ".npm"),
  // Preserve the shared fake-timer scheduler contract after stripping host options.
  PASEO_GIT_MAX_PROCESSES_PER_SECOND: "10000",
});
await Promise.all(
  [daemonHome, codexHome, claudeHome].map((directory) => mkdir(directory, { recursive: true })),
);
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});
