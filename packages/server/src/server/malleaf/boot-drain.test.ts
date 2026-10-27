import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { publishBootDrainMarker, readBootDrainMarker, restoreBootDrain } from "./boot-drain.js";

const roots: string[] = [];
const drainId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "malleaf-boot-drain-"));
  roots.push(home);
  return home;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("release survives a new reader and is create-once per epoch token", async () => {
  const home = await fixture();
  const invalid = (error: unknown) => {
    throw error;
  };
  expect(await readBootDrainMarker(home, invalid)).toBeNull();
  await publishBootDrainMarker(home, drainId);
  const filename = path.join(home, "runtime/boot-drain-released.json");
  const before = await readFile(filename, "utf8");
  expect(await readBootDrainMarker(home, invalid)).toBe(drainId);
  await publishBootDrainMarker(home, drainId);
  await expect(publishBootDrainMarker(home, otherId)).rejects.toThrow("another token");
  expect(await readFile(filename, "utf8")).toBe(before);
});

test("corrupt release evidence cannot open the gate or be silently overwritten", async () => {
  const home = await fixture();
  await mkdir(path.join(home, "runtime"));
  const filename = path.join(home, "runtime/boot-drain-released.json");
  await writeFile(filename, "{");
  const errors: unknown[] = [];
  expect(await readBootDrainMarker(home, (error) => errors.push(error))).toBeNull();
  expect(errors).toHaveLength(1);
  await expect(publishBootDrainMarker(home, drainId)).rejects.toThrow();
  expect(await readFile(filename, "utf8")).toBe("{");
});

test("release storage refuses a linked runtime directory", async () => {
  const home = await fixture();
  const external = await fixture();
  await symlink(
    external,
    path.join(home, "runtime"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(readBootDrainMarker(home, () => {})).rejects.toThrow("real directory");
  await expect(publishBootDrainMarker(home, drainId)).rejects.toThrow("real directory");
});

test("only a matching release suppresses boot adoption before services start", async () => {
  const home = await fixture();
  const adopted: string[] = [];
  const options = {
    home,
    drainId,
    adopt: (token: string) => adopted.push(token),
    onInvalid: () => {},
  };
  await restoreBootDrain(options);
  expect(adopted).toEqual([drainId]);
  adopted.length = 0;
  await publishBootDrainMarker(home, drainId);
  await restoreBootDrain(options);
  expect(adopted).toEqual([]);
  await restoreBootDrain({ ...options, drainId: otherId });
  expect(adopted).toEqual([otherId]);
});
