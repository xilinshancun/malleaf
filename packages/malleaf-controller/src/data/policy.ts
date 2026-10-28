import { z } from "zod";
import { relativePath } from "../storage.js";

export const dataPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    entries: z.record(
      z.string(),
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("copied") }),
        z.object({ kind: z.literal("runtime") }),
        z.object({ kind: z.literal("shared"), target: z.string().min(1) }),
      ]),
    ),
  })
  .superRefine((value, context) => {
    for (const key of Object.keys(value.entries)) {
      try {
        relativePath(key);
        if (key.includes("/")) throw new Error("Data policies classify top-level entries");
      } catch {
        context.addIssue({ code: "custom", message: `Invalid top-level data policy: ${key}` });
      }
      const rule = value.entries[key];
      const fixedCopy = ["server-id", "daemon-keypair.json", "config.json"].includes(key);
      const fixedShared = ["plugins", "worktrees", "models"].includes(key);
      if (
        (fixedCopy && rule.kind !== "copied") ||
        fixedShared ||
        (isRuntimeEntry(key) && rule.kind !== "runtime")
      ) {
        context.addIssue({
          code: "custom",
          message: `Built-in data ownership cannot be changed by policy: ${key}`,
        });
      }
    }
  });
export type DataPolicy = z.infer<typeof dataPolicySchema>;

const runtimeEntries = new Set([
  "paseo.pid",
  "local-credential",
  "runtime",
  "uploads",
  "agent-timelines",
  "desktop-attachments", // Client drafts belong to Electron userData, not an epoch.
  "epoch.json",
]);
export function isRuntimeEntry(name: string): boolean {
  return (
    runtimeEntries.has(name) ||
    name === "daemon.log" ||
    name.startsWith("daemon.log.") ||
    /^\d{8}-\d{4}-\d+-daemon\.log$/.test(name)
  );
}

export interface SharedDirectories {
  plugins: string;
  worktrees: string;
  models: string;
}

export interface EpochBlocker {
  code:
    | "source_locked"
    | "shared_dir_in_home"
    | "external_symlink"
    | "size_over_threshold"
    | "config_path_unmapped"
    | "registry_path_in_home"
    | "source_path_in_json"
    | "unsupported_file"
    | "internal_link_excluded";
  path: string;
  detail: string;
}
