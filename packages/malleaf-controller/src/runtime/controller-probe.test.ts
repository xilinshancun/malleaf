import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createRuntimeFixture, removeFixture } from "../test-fixtures/runtime.js";
import { initializeRuntime } from "../runner/initialize.js";
import { verifyCandidateController } from "./controller-probe.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeFixture(root);
});

async function fixture(body: string) {
  const f = await createRuntimeFixture();
  roots.push(f.root);
  const pair = await f.pair("probe", body, true);
  await initializeRuntime({ home: f.home, initialPair: pair });
  const fakeHome = path.join(f.root, "os-home");
  await mkdir(fakeHome);
  return {
    ...f,
    acceptanceRoot: f.root,
    slotDirectory: path.join(f.home, "versions", pair.buildId),
    buildId: pair.buildId,
    environment: { HOME: fakeHome, MALLEAF_TEST: "1" },
  };
}

const identity = `require("node:path").basename(require("node:path").dirname(process.argv[1]))`;
test("self-check requires verified identity and exit, and never sends permission to acquire", async () => {
  const f = await fixture(`
    const buildId = ${identity};
    process.on("message", () => process.exit(19));
    process.send({ type: "malleaf.controller.loaded", version: 1, buildId });
    setTimeout(() => process.send({ type: "malleaf.controller.verified", buildId }, () => process.exit(0)), 50);
  `);
  const before = await readFile(f.filename, "utf8");
  await verifyCandidateController(f);
  expect(await readFile(f.filename, "utf8")).toBe(before);
});

test("wrong self-reported identity and nonzero exit both reject the candidate", async () => {
  for (const body of [
    `process.send({type:"malleaf.controller.verified",buildId:"wrong"},()=>process.exit(0));`,
    `process.send({type:"malleaf.controller.verified",buildId:${identity}},()=>process.exit(42));`,
  ]) {
    const f = await fixture(body);
    await expect(verifyCandidateController(f)).rejects.toThrow("self-check failed");
  }
});

test("a hung self-check is terminated before the probe reports failure", async () => {
  const f = await fixture(`setInterval(() => {}, 1000);`);
  await expect(verifyCandidateController({ ...f, timeoutMs: 100 })).rejects.toThrow("timeout=true");
});
