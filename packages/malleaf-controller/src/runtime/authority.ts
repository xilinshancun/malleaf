import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { readDaemonInstance } from "@getpaseo/server/daemon-control";
import {
  loadControllerAuthority,
  controllerTokenHash,
  CONTROLLER_AUTHORITY_FILE,
} from "@getpaseo/server/malleaf-runtime";
import { assertStoragePath } from "../isolation.js";
import { containedRealPath, StorageError, writeJsonAtomic } from "../storage.js";

export async function verifyRuntimeAuthority(home: string, token: string): Promise<void> {
  const authority = await loadControllerAuthority(home, controllerTokenHash(token));
  if (!authority?.isAuthorized(token))
    throw new StorageError(
      "identity_conflict",
      "Runtime controller authority does not match its registration",
    );
}

// Called only after the durable launch intent and clearStopped have proved that
// no recorded supervisor remains. The control lease excludes other controllers.
export async function publishRuntimeAuthority(
  home: string,
  token: string,
  assertOwned: () => void,
): Promise<string> {
  assertOwned();
  assertStoragePath(home);
  if (await readDaemonInstance(home))
    throw new StorageError("state_conflict", "Cannot replace authority of a live runtime");
  const directory = path.join(home, "runtime");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory())
    throw new StorageError("unsafe_path", "Runtime must be a real directory");
  await containedRealPath(await containedRealPath(home, home), directory);
  const tokenHash = controllerTokenHash(token);
  await writeJsonAtomic({
    filename: path.join(directory, CONTROLLER_AUTHORITY_FILE),
    value: { schemaVersion: 1, tokenHash },
    mode: "replace",
    beforeCommit: assertOwned,
  });
  return tokenHash;
}
