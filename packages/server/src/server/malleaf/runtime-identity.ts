import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  MalleafRuntimeIdentitySchema,
  type MalleafRuntimeIdentity,
} from "@getpaseo/protocol/malleaf/runtime-identity";

const manifestIdentitySchema = z.object({
  schemaVersion: z.literal(1),
  buildId: MalleafRuntimeIdentitySchema.shape.buildId,
  provenance: MalleafRuntimeIdentitySchema.omit({ buildId: true }),
});

// Reporting is not verification: the controller independently verifies the artifact,
// process identity and this response. A checkout must never report another slot's identity.
export async function readMalleafRuntimeIdentity(options: {
  manifestPath?: string;
  moduleUrl: string;
}): Promise<MalleafRuntimeIdentity | undefined> {
  if (!options.manifestPath) return undefined;
  const manifestPath = await realpath(options.manifestPath);
  const slot = path.dirname(manifestPath);
  const modulePath = await realpath(fileURLToPath(options.moduleUrl));
  const relative = path.relative(slot, modulePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Malleaf runtime code is outside the selected slot");
  }
  const manifest = manifestIdentitySchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  if (path.basename(slot) !== manifest.buildId || path.basename(manifestPath) !== "malleaf.json") {
    throw new Error("Malleaf runtime manifest does not match its slot directory");
  }
  return { ...manifest.provenance, buildId: manifest.buildId };
}
