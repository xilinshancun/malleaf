import { createHash } from "node:crypto";
import { z } from "zod";
import { relativePath } from "../storage.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const storedPath = z.string().refine((value) => {
  try {
    return relativePath(value) === value;
  } catch {
    return false;
  }
}, "Expected a portable relative path");

export const artifactRecordSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    path: storedPath,
    sha256: digest,
    size: z.number().int().nonnegative(),
    executable: z.boolean(),
  }),
  z.object({ kind: z.literal("link"), path: storedPath, target: z.string().min(1) }),
]);
export type ArtifactRecord = z.infer<typeof artifactRecordSchema>;

export const provenanceSchema = z.object({
  product: z.string().min(1),
  display: z.string().min(1),
  sourceCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  upstream: z.string().regex(/^[a-f0-9]{40,64}$/),
  builder: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type Provenance = z.infer<typeof provenanceSchema>;

export const slotManifestSchema = z.object({
  schemaVersion: z.literal(1),
  buildId: digest,
  provenance: provenanceSchema,
  entries: z.record(z.string().min(1), storedPath).refine((value) => Object.keys(value).length > 0),
  files: z.array(artifactRecordSchema).min(1),
});
export type SlotManifest = z.infer<typeof slotManifestSchema>;

export function buildIdentity({
  files,
  entries,
  provenance,
}: Pick<SlotManifest, "files" | "entries" | "provenance">): string {
  const ordered = [...files].sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return 0;
  });
  const orderedEntries = Object.fromEntries(
    Object.entries(entries).sort(([a], [b]) => a.localeCompare(b, "en")),
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        files: ordered,
        entries: orderedEntries,
        provenance: provenanceSchema.parse(provenance),
      }),
    )
    .digest("hex");
}
