import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { assertSlotDependencyBoundary } from "./daemon.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("a missing slot dependency cannot fall back to a poisoned ancestor node_modules", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "slot-boundary-test-")));
  roots.push(root);
  const slot = path.join(root, "product", "versions", "a".repeat(64));
  await mkdir(slot, { recursive: true });
  await expect(assertSlotDependencyBoundary(slot)).resolves.toBeUndefined();
  const poison = path.join(root, "node_modules", "zod");
  await mkdir(poison, { recursive: true });
  await writeFile(
    path.join(poison, "index.js"),
    "throw new Error('borrowed code from outside slot');",
  );
  await expect(assertSlotDependencyBoundary(slot)).rejects.toThrow(
    "ancestor contains node_modules",
  );
});
