import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { readMalleafRuntimeIdentity } from "./runtime-identity.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("reports the selected slot identity only for code loaded from that slot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "malleaf-runtime-identity-"));
  roots.push(root);
  const buildId = "a".repeat(64);
  const slot = path.join(root, buildId);
  const entry = path.join(slot, "packages/server/dist/server/bootstrap.js");
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(entry, "export {};");
  const manifestPath = path.join(slot, "malleaf.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      buildId,
      provenance: { product: "0.1.0", display: "0.1.0.linjiu-1", upstream: "b".repeat(40) },
    }),
  );
  await expect(
    readMalleafRuntimeIdentity({ manifestPath, moduleUrl: pathToFileURL(entry).href }),
  ).resolves.toEqual({
    product: "0.1.0",
    display: "0.1.0.linjiu-1",
    buildId,
    upstream: "b".repeat(40),
  });
  await expect(
    readMalleafRuntimeIdentity({ manifestPath, moduleUrl: import.meta.url }),
  ).rejects.toThrow("outside the selected slot");
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      buildId: "c".repeat(64),
      provenance: { product: "0.1.0", display: "0.1.0.linjiu-1", upstream: "b".repeat(40) },
    }),
  );
  await expect(
    readMalleafRuntimeIdentity({ manifestPath, moduleUrl: pathToFileURL(entry).href }),
  ).rejects.toThrow("does not match its slot directory");
  await writeFile(manifestPath, "{");
  await expect(
    readMalleafRuntimeIdentity({ manifestPath, moduleUrl: pathToFileURL(entry).href }),
  ).rejects.toThrow(SyntaxError);
});

test("development without a selected manifest does not invent a build identity", async () => {
  await expect(readMalleafRuntimeIdentity({ moduleUrl: import.meta.url })).resolves.toBeUndefined();
});
