#!/usr/bin/env npx tsx

import assert from "node:assert";
import { runLocalPaseo } from "./helpers/local-cli.ts";
import { startTestDaemon } from "./helpers/test-daemon.ts";

console.log("=== Daemon Auth Command Errors ===\n");

const daemon = await startTestDaemon({
  env: { MALLEAF_PASSWORD: "shared-secret" },
});

async function lsError(password: string, remoteClient = false) {
  const result = await runLocalPaseo(["ls", "--json"], {
    MALLEAF_DAEMON_HOME: remoteClient ? undefined : daemon.paseoHome,
    MALLEAF_HOST: remoteClient ? `127.0.0.1:${daemon.port}` : "",
    MALLEAF_PASSWORD: password,
  });
  assert.notStrictEqual(result.exitCode, 0, "ls should fail without a valid password");
  return JSON.parse(result.stderr).error as {
    code: string;
    message: string;
    details: string;
  };
}

try {
  {
    console.log("Test 1: a client outside the daemon home needs MALLEAF_PASSWORD");
    const error = await lsError("", true);
    assert.strictEqual(error.code, "AUTH_REQUIRED");
    assert.match(error.message, /Password required/);
    assert.match(error.details, /MALLEAF_PASSWORD/);
    assert.doesNotMatch(error.details, /daemon start/);
    console.log("✓ client without the local credential is asked for MALLEAF_PASSWORD\n");
  }

  {
    console.log("Test 2: wrong password asks for MALLEAF_PASSWORD, not a daemon start");
    const error = await lsError("wrong-secret");
    assert.strictEqual(error.code, "AUTH_FAILED");
    assert.match(error.message, /Incorrect password/);
    assert.match(error.details, /MALLEAF_PASSWORD/);
    assert.doesNotMatch(error.details, /daemon start/);
    console.log("✓ wrong password points at MALLEAF_PASSWORD\n");
  }
} finally {
  await daemon.stop();
}

console.log("=== Daemon Auth Command Errors Tests Passed ===");
