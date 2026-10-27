import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll } from "vitest";

// Load package-local .env.test first for integration/E2E credentials, then repo-root .env fallback.
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: path.resolve(serverRoot, ".env.test"), override: true });
dotenv.config({ path: path.resolve(serverRoot, "../.env") });

// RFC-0001: Tests that omit an explicit daemon home must never read a running
// installation. Provider auth remains provider-owned; process acceptance tests
// additionally redirect HOME and use fixture provider directories.
const isolatedHome = mkdtempSync(path.join(tmpdir(), "malleaf-vitest-"));
for (const key of Object.keys(process.env)) {
  if (key.startsWith("MALLEAF_") || key.startsWith("PASEO_")) delete process.env[key];
}
process.env.MALLEAF_HOME = path.join(isolatedHome, "product");
delete process.env.MALLEAF_DAEMON_HOME;
delete process.env.PASEO_HOST;
process.env.PASEO_HOME = isolatedHome;
process.env.MALLEAF_DAEMON_HOME = isolatedHome;
afterAll(() => rmSync(isolatedHome, { recursive: true, force: true }));

// Restore the test runner's deliberate high cap after removing host overrides.
// Fake-timer suites otherwise freeze the scheduler before queued work can run.
process.env.PASEO_GIT_MAX_PROCESSES_PER_SECOND = "10000";
process.env.PASEO_SUPERVISED = "0";
process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GIT_SSH_COMMAND = "ssh -oBatchMode=yes";
process.env.SSH_ASKPASS = "/usr/bin/false";
process.env.SSH_ASKPASS_REQUIRE = "force";
process.env.DISPLAY = process.env.DISPLAY ?? "1";
