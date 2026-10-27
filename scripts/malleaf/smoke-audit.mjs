import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "../..");

export async function bindControllerBuild(manifest) {
  const { stdout: head } = await execute("git", ["rev-parse", "HEAD"], { cwd: repo });
  const { stdout: status } = await execute("git", ["status", "--porcelain"], { cwd: repo });
  assert.equal(status.trim(), "", "process acceptance requires a clean checkout");
  assert.equal(head.trim(), manifest.provenance.sourceCommit);
  const hashes = {};
  for (const file of manifest.files) {
    if (file.kind !== "file" || !/^packages\/(?:malleaf-controller|server)\/dist\//.test(file.path))
      continue;
    const hash = createHash("sha256")
      .update(await readFile(path.join(repo, file.path)))
      .digest("hex");
    assert.equal(hash, file.sha256, `Host build differs from the copied artifact: ${file.path}`);
    hashes[file.path] = hash;
  }
  assert.ok(
    hashes["packages/malleaf-controller/dist/runtime/activation.js"],
    "Trace must include the trusted activation controller",
  );
  return {
    controllerCommit: head.trim(),
    clean: true,
    hostDistHashes: hashes,
    platform: process.platform,
    node: process.version,
  };
}

export async function captureHostState() {
  const paths = [".malleaf", "Library/Application Support/Malleaf", "Library/Logs/Malleaf"];
  const malleaf = {};
  for (const relative of paths) {
    const filename = path.join(os.homedir(), relative);
    try {
      const stat = await lstat(filename);
      malleaf[filename] = { inode: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      malleaf[filename] = null;
    }
  }
  const filename = path.join(os.homedir(), ".paseo/paseo.pid");
  let paseo = null;
  try {
    const info = JSON.parse(await readFile(filename, "utf8"));
    const stat = await lstat(filename);
    // The installed daemon legitimately refreshes its heartbeat/mtime while the
    // smoke runs. Compare instance identity, not that changing timestamp.
    paseo = { pid: info.pid, startedAt: info.startedAt, inode: stat.ino };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const lsof = process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof";
  const listener = await execute(lsof, ["-nP", "-iTCP:6767", "-sTCP:LISTEN", "-t"]).catch(
    (error) => {
      if (error.code !== 1) throw error;
      return { stdout: "" };
    },
  );
  return {
    malleaf,
    paseo,
    paseoListenerPids: listener.stdout.trim().split(/\s+/).filter(Boolean).sort(),
  };
}

export async function assertNoSlotProcesses(root) {
  const { stdout } = await execute("ps", ["-axo", "pid=,ppid=,command="], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const remaining = stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match && match[3].includes(root)
      ? [{ pid: Number(match[1]), ppid: Number(match[2]) }]
      : [];
  });
  assert.deepEqual(remaining, [], "A process still references the acceptance root");
  return remaining;
}
