import { expect, test } from "vitest";
import { isolateRuntimeNodeEnvironment } from "./environment.js";

test("keeps host loaders out of the daemon while recording their original external settings", () => {
  const original = {
    NODE_OPTIONS: "--require /host/proxy.cjs --max-old-space-size=2048",
    NODE_PATH: "/host/node_modules",
    MALLEAF_HOST_NODE_OPTIONS: "forged",
    MALLEAF_HOST_NODE_PATH: "forged",
    PATH: "/usr/bin",
  };
  const managed = isolateRuntimeNodeEnvironment(original);
  expect(managed).toMatchObject({
    NODE_OPTIONS: "--no-global-search-paths",
    NODE_PATH: "",
    MALLEAF_HOST_NODE_OPTIONS: original.NODE_OPTIONS,
    MALLEAF_HOST_NODE_PATH: original.NODE_PATH,
    PATH: original.PATH,
  });
  expect(original.NODE_OPTIONS).toContain("--require");
  expect(isolateRuntimeNodeEnvironment({})).toMatchObject({
    MALLEAF_HOST_NODE_OPTIONS: "",
    MALLEAF_HOST_NODE_PATH: "",
  });
});
