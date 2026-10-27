import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const testOsHome = mkdtempSync(path.join(tmpdir(), "malleaf-cli-test-os-"));
process.once("exit", () => rmSync(testOsHome, { recursive: true, force: true }));
