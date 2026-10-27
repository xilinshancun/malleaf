import path from "node:path";
import { mergeConfig } from "vitest/config";
import sharedConfig from "../../vitest.config";

export default mergeConfig(sharedConfig, {
  test: { setupFiles: [path.join(import.meta.dirname, "test/setup.ts")] },
});
