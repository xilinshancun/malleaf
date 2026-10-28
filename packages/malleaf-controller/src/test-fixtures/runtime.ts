import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { materializeSlot } from "../slot/materialize.js";
import { executeEpochCopy, planEpochCopy } from "../data/epoch.js";

export async function removeFixture(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await removeFixture(filename);
    else await rm(filename, { force: true });
  }
  await rm(directory, { recursive: true });
}

export async function createRuntimeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "malleaf-pointer-"));
  const sourceRoot = path.join(root, "source");
  const seed = path.join(root, "seed");
  const home = path.join(root, "product");
  await mkdir(sourceRoot);
  await mkdir(seed);
  const shared = {
    plugins: path.join(home, "plugins"),
    worktrees: path.join(home, "worktrees"),
    models: path.join(home, "models/local-speech"),
  };
  await mkdir(shared.plugins, { recursive: true });
  async function pair(dataId: string, runner?: string) {
    await writeFile(
      path.join(sourceRoot, "main.js"),
      runner ?? `console.log(${JSON.stringify(dataId)});`,
    );
    const slot = await materializeSlot({
      sourceRoot,
      versionsRoot: path.join(home, "versions"),
      paths: ["main.js"],
      entries: { supervisor: "main.js", ...(runner === undefined ? {} : { runner: "main.js" }) },
      provenance: {
        product: "0.1.0",
        display: `0.1.0.alice-${dataId}`,
        sourceCommit: "a".repeat(40),
        upstream: "b".repeat(40),
        builder: "test",
        createdAt: "2026-10-28T00:00:00.000Z",
      },
    });
    const buildId = slot.manifest.buildId;
    await executeEpochCopy(
      await planEpochCopy({
        sourceHome: seed,
        dataRoot: path.join(home, "data"),
        dataId,
        buildId,
        shared,
        policy: { schemaVersion: 1, entries: {} },
      }),
    );
    return { buildId, dataId };
  }
  return {
    root,
    home,
    pair,
    filename: path.join(home, "runner/current.json"),
    writerToken: "test-controller-token",
    assertOwned() {},
  };
}
