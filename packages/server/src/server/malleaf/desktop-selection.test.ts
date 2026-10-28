import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { resolveDesktopDaemonSelection } from "./desktop-selection.js";
import type { DaemonInstance } from "../daemon-instance.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const current = { buildId: "a".repeat(64), dataId: "current" };
const trial = { buildId: "b".repeat(64), dataId: "trial" };
const lock: DaemonInstance = {
  pid: process.pid,
  startedAt: new Date().toISOString(),
  hostname: "test",
  uid: 1,
  listen: "127.0.0.1:1",
};
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "malleaf-desktop-selection-"));
  roots.push(root);
  const home = path.join(root, "product");
  const runner = path.join(home, "runner");
  await mkdir(runner, { recursive: true });
  for (const pair of [current, trial])
    await mkdir(path.join(home, "data", pair.dataId), { recursive: true });
  const pointer = {
    schemaVersion: 1,
    minReaderVersion: 1,
    current,
    trial: { pair: trial },
    unknown: "retained",
  };
  const filename = path.join(runner, "current.json");
  const publish = (value: unknown) => writeFile(filename, JSON.stringify(value));
  await publish(pointer);
  const readInstance = vi.fn(async (_home: string): Promise<DaemonInstance | null> => null);
  const select = () => resolveDesktopDaemonSelection({ env: { MALLEAF_HOME: home }, readInstance });
  return { root, home, runner, pointer, filename, publish, readInstance, select };
}

test("only an absent runner directory permits the legacy desktop home", async () => {
  const f = await fixture();
  await rm(f.runner, { recursive: true });
  expect(await f.select()).toEqual({
    ownership: "desktop",
    daemonHome: path.join(f.home, "daemon"),
  });
  expect(f.readInstance).not.toHaveBeenCalled();
});

test("an initialized home with a lost pointer cannot revive the legacy daemon", async () => {
  const f = await fixture();
  await rm(f.filename);
  await writeFile(path.join(f.runner, "runner.json"), "{}");
  expect(await f.select()).toMatchObject({
    ownership: "controller",
    error: expect.stringMatching(/runtime pointer is missing/),
  });
  expect(f.readInstance).not.toHaveBeenCalled();
});

test("selects the sole living current or trial, and retains controller ownership when both stop", async () => {
  const f = await fixture();
  const before = await readFile(f.filename, "utf8");
  expect(await f.select()).toMatchObject({
    ownership: "controller",
    pair: current,
    instance: null,
    error: null,
  });
  f.readInstance.mockImplementation(async (home) =>
    path.basename(home) === "trial" ? lock : null,
  );
  expect(await f.select()).toMatchObject({
    ownership: "controller",
    pair: trial,
    instance: lock,
    error: null,
  });
  f.readInstance.mockImplementation(async () => lock);
  expect(await f.select()).toMatchObject({
    ownership: "controller",
    daemonHome: null,
    error: expect.stringMatching(/Multiple/),
  });
  expect(await readFile(f.filename, "utf8")).toBe(before);
});

test.each(["json", "future", "traversal", "same-epoch", "missing-epoch"])(
  "invalid %s pointer remains controller-owned",
  async (kind) => {
    const f = await fixture();
    if (kind === "json") await writeFile(f.filename, "{");
    if (kind === "future") await f.publish({ ...f.pointer, schemaVersion: 2, minReaderVersion: 2 });
    if (kind === "traversal")
      await f.publish({ ...f.pointer, current: { ...current, dataId: "../escape" } });
    if (kind === "same-epoch") await f.publish({ ...f.pointer, trial: { pair: current } });
    if (kind === "missing-epoch") await rm(path.join(f.home, "data/current"), { recursive: true });
    expect(await f.select()).toMatchObject({
      ownership: "controller",
      daemonHome: null,
      error: expect.any(String),
    });
  },
);

test.each(["runner", "pointer", "epoch"] as const)(
  "redirected %s is never treated as an absent controller",
  async (kind) => {
    const f = await fixture();
    const outside = path.join(f.root, "outside");
    await mkdir(outside);
    const target = {
      runner: f.runner,
      pointer: f.filename,
      epoch: path.join(f.home, "data/current"),
    }[kind]!;
    await rm(target, { recursive: true, force: true });
    if (kind === "pointer") {
      await writeFile(path.join(outside, "current.json"), JSON.stringify(f.pointer));
      await symlink(path.join(outside, "current.json"), target, "file");
    } else await symlink(outside, target, process.platform === "win32" ? "junction" : "dir");
    expect(await f.select()).toMatchObject({
      ownership: "controller",
      daemonHome: null,
      error: expect.any(String),
    });
  },
);

test("a pointer change while reading pid locks cannot produce a stale selected home", async () => {
  const f = await fixture();
  f.readInstance.mockImplementation(async () => {
    await f.publish({ ...f.pointer, seq: 2 });
    return lock;
  });
  expect(await f.select()).toMatchObject({
    ownership: "controller",
    error: expect.stringMatching(/selection changed/),
  });
});

test("an empty runner directory is an incomplete controller initialization, never desktop ownership", async () => {
  const f = await fixture();
  await rm(f.filename);
  expect(await f.select()).toMatchObject({ ownership: "controller", error: expect.any(String) });
});
