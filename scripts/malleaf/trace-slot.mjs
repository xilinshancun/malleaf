#!/usr/bin/env node
// Run this trusted copy against a cleanly built worktree. This only inventories
// files; the controller separately materializes and verifies the copied slot.
import { readFile, lstat, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";

const repoRoot = path.resolve(process.argv[2] ?? ".");
const entries = {
  supervisor: "packages/server/dist/scripts/supervisor-entrypoint.js",
  worker: "packages/server/dist/server/server/daemon-worker.js",
  activation: "packages/malleaf-controller/dist/runtime/activation.js",
  initializer: "packages/malleaf-controller/dist/runner/initialize.js",
  lease: "packages/malleaf-controller/dist/runner/lease.js",
};
const exported = [];
// Trace the daemon/control API actually shipped in the slot. Unrelated upstream
// public utilities are not all emitted by build:server and are not runtime roots.
const serverExports = new Set([
  ".",
  "./malleaf-runtime",
  "./daemon-control",
  "./configuration",
  "./process",
]);
for (const directory of ["packages/server", "packages/cli", "packages/malleaf-controller"]) {
  const manifest = JSON.parse(
    await readFile(path.join(repoRoot, directory, "package.json"), "utf8"),
  );
  const bins =
    typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {});
  for (const bin of bins) exported.push(path.posix.join(directory, bin));
  for (const [name, specifier] of Object.entries(manifest.exports ?? {})) {
    if (directory === "packages/server" && !serverExports.has(name)) continue;
    const filename = typeof specifier === "string" ? specifier : specifier.default;
    if (filename) exported.push(path.posix.join(directory, filename));
  }
}
entries.cli = "packages/cli/dist/index.js";
for (const filename of [...Object.values(entries), ...exported]) {
  if (!(await lstat(path.join(repoRoot, filename))).isFile())
    throw new Error(`Missing built entry: ${filename}`);
}
const home = await mkdtemp(path.join(os.tmpdir(), "malleaf-trace-home-"));
try {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("PASEO_") && !key.startsWith("MALLEAF_"),
    ),
  );
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"),
  });
  const result = await promisify(execFile)(
    process.execPath,
    [
      path.resolve(import.meta.dirname, "../trace-daemon.mjs"),
      "--root",
      repoRoot,
      ...exported.flatMap((filename) => ["--entry", filename]),
      ...Object.values(entries).flatMap((filename) => ["--entry", filename]),
    ],
    { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024, env },
  );
  process.stderr.write(result.stderr);
  // nft can mistake project Git operations for a runtime dependency on this
  // checkout's index. Repository metadata belongs to source, never a slot.
  const files = result.stdout
    .trim()
    .split("\n")
    .filter((filename) => !filename.split("/").some((segment) => segment.toLowerCase() === ".git"));
  process.stdout.write(`${JSON.stringify({ entries, files }, null, 2)}\n`);
} finally {
  await rm(home, { recursive: true, force: true });
}
