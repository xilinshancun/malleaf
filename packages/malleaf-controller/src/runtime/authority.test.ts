import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { publishRuntimeAuthority, verifyRuntimeAuthority } from "./authority.js";

test("authority rotates only for stopped homes and a lost lease cannot publish a replacement", async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "authority-marker-test-")));
  try {
    const first = randomBytes(32).toString("hex");
    const second = randomBytes(32).toString("hex");
    await publishRuntimeAuthority(home, first, () => {});
    const filename = path.join(home, "runtime/controller-authority.json");
    const original = await readFile(filename, "utf8");
    expect(original).not.toContain(first);
    if (process.platform !== "win32") expect((await stat(filename)).mode & 0o777).toBe(0o600);
    await verifyRuntimeAuthority(home, first);
    let checks = 0;
    await expect(
      publishRuntimeAuthority(home, second, () => {
        if (++checks === 2) throw new Error("lease lost");
      }),
    ).rejects.toThrow("lease lost");
    expect(await readFile(filename, "utf8")).toBe(original);
    const lock = path.join(home, "paseo.pid");
    await writeFile(
      lock,
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        hostname: os.hostname(),
        uid: process.getuid?.() ?? 0,
        listen: null,
      }),
    );
    await expect(publishRuntimeAuthority(home, second, () => {})).rejects.toThrow("live runtime");
    expect(await readFile(filename, "utf8")).toBe(original);
    await rm(lock); // Only this test's observation fixture; no process was started.
    await publishRuntimeAuthority(home, second, () => {});
    await verifyRuntimeAuthority(home, second);
    await expect(verifyRuntimeAuthority(home, first)).rejects.toThrow("changed");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
