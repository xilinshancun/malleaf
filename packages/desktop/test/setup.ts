import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

// The desktop suite can import daemon storage helpers without a launcher.
// Give every test file its own state and provider configuration boundaries.
const home = await mkdtemp(path.join(os.tmpdir(), "malleaf-desktop-test-"));
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PASEO_") || key.startsWith("MALLEAF_")) delete process.env[key];
}
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  MALLEAF_HOME: path.join(home, ".malleaf"),
  MALLEAF_DAEMON_HOME: path.join(home, ".malleaf", "daemon"),
  MALLEAF_TEST: "1",
  CODEX_HOME: path.join(home, ".codex"),
  CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
});
await mkdir(process.env.MALLEAF_DAEMON_HOME!, { recursive: true });
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});
