import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

const roots: string[] = [];
const entry = path.join(import.meta.dirname, "stable.cjs");
const current = "a".repeat(64);
const previous = "b".repeat(64);
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "malleaf-stable-test-"));
  roots.push(root);
  const home = path.join(root, "product");
  const fakeHome = path.join(root, "os-home");
  await mkdir(path.join(home, "runner"), { recursive: true });
  await mkdir(fakeHome);
  await writeFile(
    path.join(home, "runner/runner.json"),
    JSON.stringify({ schemaVersion: 1, minReaderVersion: 1, controlPort: 23456 }),
  );
  const pointer = JSON.stringify({
    schemaVersion: 1,
    minReaderVersion: 1,
    current: { buildId: current, dataId: "current" },
    previous: { buildId: previous, dataId: "previous" },
  });
  await writeFile(path.join(home, "runner/current.json"), pointer);
  async function slot(buildId: string, code: string, corrupt = false) {
    const directory = path.join(home, "versions", buildId);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "boot.cjs"), code);
    await writeFile(
      path.join(directory, "malleaf.json"),
      JSON.stringify({
        schemaVersion: 1,
        buildId,
        entries: { controller: "boot.cjs" },
        files: [
          {
            kind: "file",
            path: "boot.cjs",
            sha256: corrupt ? "0".repeat(64) : createHash("sha256").update(code).digest("hex"),
          },
        ],
      }),
    );
  }
  function loaded(buildId: string, exitCode: number) {
    return `process.on("message", m => { if(m.type === "malleaf.controller.proceed") { require("node:fs").writeFileSync(${JSON.stringify(path.join(root, buildId))}, "ack"); process.exit(${exitCode}); } }); process.send({type:"malleaf.controller.loaded",version:1,buildId:${JSON.stringify(buildId)}});`;
  }
  async function run(acceptance = true) {
    const child = spawn(
      process.execPath,
      [entry, "--home", home, ...(acceptance ? ["--acceptance-root", root] : [])],
      {
        env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, MALLEAF_TEST: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    return { code, stderr };
  }
  return { root, home, pointer, slot, loaded, run };
}

test("only a controller that fails before the acknowledged boundary gets one fallback", async () => {
  const f = await fixture();
  await f.slot(current, 'throw new Error("broken entry");');
  await f.slot(previous, f.loaded(previous, 0));
  expect((await f.run()).code).toBe(0);
  const diagnostic = JSON.parse(
    await readFile(path.join(f.home, "runner/stable/last-boot.json"), "utf8"),
  );
  expect(diagnostic.attempts.map((attempt: { loaded: boolean }) => attempt.loaded)).toEqual([
    false,
    true,
  ]);
  expect(await readFile(path.join(f.root, previous), "utf8")).toBe("ack");
  expect(await readFile(path.join(f.home, "runner/current.json"), "utf8")).toBe(f.pointer);
});

test.each([1, 65, 72, 73, 78])(
  "after acknowledgement, exit %i is diagnosed without fallback",
  async (code) => {
    const f = await fixture();
    await f.slot(current, f.loaded(current, code));
    await f.slot(previous, f.loaded(previous, 0));
    expect((await f.run()).code).toBe(code);
    const diagnostic = JSON.parse(
      await readFile(path.join(f.home, "runner/stable/last-boot.json"), "utf8"),
    );
    expect(diagnostic.attempts).toHaveLength(1);
    await expect(readFile(path.join(f.root, previous))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("entry hash mismatch never executes that entry and can use the previous controller", async () => {
  const f = await fixture();
  await f.slot(current, f.loaded(current, 0), true);
  await f.slot(previous, f.loaded(previous, 0));
  expect((await f.run()).code).toBe(0);
  await expect(readFile(path.join(f.root, current))).rejects.toMatchObject({ code: "ENOENT" });
});

test("unsupported pointer schema stops before spawning any controller", async () => {
  const f = await fixture();
  await f.slot(current, f.loaded(current, 0));
  await writeFile(
    path.join(f.home, "runner/current.json"),
    JSON.stringify({ schemaVersion: 2, minReaderVersion: 2 }),
  );
  expect((await f.run()).code).toBe(65);
  await expect(readFile(path.join(f.root, current))).rejects.toMatchObject({ code: "ENOENT" });
});

test("a missing current selection cannot be disguised as a previous-controller fallback", async () => {
  const f = await fixture();
  await f.slot(previous, f.loaded(previous, 0));
  await writeFile(
    path.join(f.home, "runner/current.json"),
    JSON.stringify({ schemaVersion: 1, minReaderVersion: 1, previous: { buildId: previous } }),
  );
  expect((await f.run()).code).toBe(65);
  await expect(readFile(path.join(f.root, previous))).rejects.toMatchObject({ code: "ENOENT" });
});

test("a rejected load identity is a failure even if the child exits zero, without fallback", async () => {
  const f = await fixture();
  await f.slot(
    current,
    `process.on("message", m => { if (m.type === "malleaf.controller.reject") process.exit(0); }); process.send({type:"malleaf.controller.loaded",version:1,buildId:${JSON.stringify(previous)}});`,
  );
  await f.slot(previous, f.loaded(previous, 0));
  expect((await f.run()).code).toBe(78);
  const diagnostic = JSON.parse(
    await readFile(path.join(f.home, "runner/stable/last-boot.json"), "utf8"),
  );
  expect(diagnostic.attempts).toHaveLength(1);
  expect(diagnostic.attempts[0]).toMatchObject({ loaded: true, interrupted: false, code: 78 });
  expect(diagnostic.attempts[0].rejected).toMatch(/mismatch/);
  await expect(readFile(path.join(f.root, previous))).rejects.toMatchObject({ code: "ENOENT" });
});

test("default invocation cannot start even a valid controller without the explicit acceptance opt-in", async () => {
  const f = await fixture();
  await f.slot(current, f.loaded(current, 0));
  expect((await f.run(false)).code).toBe(65);
  await expect(readFile(path.join(f.root, current))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(path.join(f.home, "runner/stable/last-boot.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("an unacknowledged hung child must exit before the previous controller can run", async () => {
  const f = await fixture();
  await f.slot(current, `setInterval(() => {}, 1000);`);
  await f.slot(previous, f.loaded(previous, 0));
  expect((await f.run()).code).toBe(0);
  const diagnostic = JSON.parse(
    await readFile(path.join(f.home, "runner/stable/last-boot.json"), "utf8"),
  );
  expect(diagnostic.attempts).toHaveLength(2);
  expect(diagnostic.attempts[0]).toMatchObject({ loaded: false, loadTimedOut: true, code: 124 });
  expect(diagnostic.attempts[1]).toMatchObject({ loaded: true, code: 0 });
}, 20_000);

test("diagnostic publication failure preserves the controller exit code", async () => {
  const f = await fixture();
  await f.slot(current, f.loaded(current, 72));
  await mkdir(path.join(f.home, "runner/stable/last-boot.json"), { recursive: true });
  const result = await f.run();
  expect(result.code).toBe(72);
  expect(result.stderr).toMatch(/Cannot save boot diagnostics/);
});
