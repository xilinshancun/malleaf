import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyAttachmentFileToManagedStorage,
  deleteManagedAttachmentFile,
  garbageCollectManagedAttachmentFiles,
  readManagedFileBase64,
} from "./attachments";

const mocks = vi.hoisted(() => ({ userData: "" }));
vi.mock("electron", () => ({ app: { getPath: () => mocks.userData } }));
const originalPaseoHome = process.env.MALLEAF_DAEMON_HOME;
let testHome: string | null = null;

async function useTempPaseoHome(): Promise<string> {
  testHome = await mkdtemp(path.join(os.tmpdir(), "paseo-desktop-attachments-"));
  process.env.MALLEAF_DAEMON_HOME = testHome;
  mocks.userData = path.join(testHome, "electron");
  return testHome;
}

describe("desktop attachment files", () => {
  afterEach(async () => {
    if (originalPaseoHome === undefined) {
      delete process.env.MALLEAF_DAEMON_HOME;
    } else {
      process.env.MALLEAF_DAEMON_HOME = originalPaseoHome;
    }

    if (testHome) {
      await rm(testHome, { recursive: true, force: true });
      testHome = null;
    }
  });

  it("accepts dot-prefixed picker extensions for managed copies", async () => {
    const paseoHome = await useTempPaseoHome();
    const sourcePath = path.join(paseoHome, "report.md");
    await writeFile(sourcePath, "# Report\n");

    const result = await copyAttachmentFileToManagedStorage({
      attachmentId: "att_markdown",
      sourcePath,
      extension: ".md",
    });

    expect(result).toEqual({
      path: path.join(mocks.userData, "desktop-attachments", "att_markdown.md"),
      byteSize: 9,
    });
    await expect(readFile(result.path, "utf8")).resolves.toBe("# Report\n");
  });

  it("normalizes legacy bare extensions for managed copies", async () => {
    const paseoHome = await useTempPaseoHome();
    const sourcePath = path.join(paseoHome, "report.md");
    await writeFile(sourcePath, "# Report\n");

    const result = await copyAttachmentFileToManagedStorage({
      attachmentId: "att_markdown_legacy",
      sourcePath,
      extension: "md",
    });

    expect(result).toEqual({
      path: path.join(mocks.userData, "desktop-attachments", "att_markdown_legacy.md"),
      byteSize: 9,
    });
    await expect(readFile(result.path, "utf8")).resolves.toBe("# Report\n");
  });
  it("keeps old draft paths readable and deletable while collecting only userData", async () => {
    const home = await useTempPaseoHome();
    const oldRoot = path.join(home, "desktop-attachments");
    await mkdir(oldRoot);
    const oldFile = path.join(oldRoot, "old.txt");
    await writeFile(oldFile, "draft");
    expect(await readManagedFileBase64({ path: oldFile })).toBe(
      Buffer.from("draft").toString("base64"),
    );
    expect(await garbageCollectManagedAttachmentFiles({ referencedIds: [] })).toBe(0);
    expect(await readFile(oldFile, "utf8")).toBe("draft");
    await expect(readManagedFileBase64({ path: path.join(home, "outside.txt") })).rejects.toThrow(
      /within desktop-managed/,
    );
    expect(await deleteManagedAttachmentFile({ path: oldFile })).toBe(true);
    await expect(readFile(oldFile)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
