import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export async function recordMalleafRuntimeEntry(
  home: string,
  supervisor: string,
  worker: string,
): Promise<void> {
  const directory = path.join(home, "runtime");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = async (file: string) => ({
    path: file,
    sha256: createHash("sha256")
      .update(await readFile(file))
      .digest("hex"),
  });
  const destination = path.join(directory, "malleaf-entry.json");
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(
    temporary,
    JSON.stringify({
      pid: process.pid,
      supervisor: await entry(supervisor),
      worker: await entry(worker),
    }),
    { mode: 0o600 },
  );
  await rename(temporary, destination);
}
