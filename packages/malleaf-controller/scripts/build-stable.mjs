import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(root, "dist/runner"), { recursive: true });
await copyFile(path.join(root, "src/runner/stable.cjs"), path.join(root, "dist/runner/stable.cjs"));
