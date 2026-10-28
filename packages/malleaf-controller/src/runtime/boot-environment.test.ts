import path from "node:path";
import os from "node:os";
import { expect, test } from "vitest";
import { acceptanceBootEnvironment } from "./boot-environment.js";
import { isolateRuntimeNodeEnvironment } from "./environment.js";
import { assertAcceptanceBoundary } from "../isolation.js";

test("boot rejects inherited controls and credentials while preserving host Node settings only for the adapter", () => {
  const root = path.resolve("disposable");
  const home = path.join(root, "product");
  const fakeHome = path.join(root, "os-home");
  const env = acceptanceBootEnvironment({
    root,
    home,
    fakeHome,
    inherited: {
      MALLEAF_LISTEN: "0.0.0.0:6767",
      MALLEAF_RELAY_ENABLED: "true",
      PASEO_HOME: "/real",
      CODEX_HOME: "/real-codex",
      PATH: "/user/bin",
      ANTHROPIC_API_KEY: "must-not-inherit",
      NODE_OPTIONS: "--require=/bad.cjs",
      MALLEAF_HOST_NODE_OPTIONS: "--max-old-space-size=2048",
      MALLEAF_HOST_NODE_PATH: "/host/modules",
    },
  });
  expect(env.MALLEAF_LISTEN).toBe("127.0.0.1:0");
  expect(env.MALLEAF_RELAY_ENABLED).toBe("false");
  expect(env.CODEX_HOME).toBe(path.join(fakeHome, ".codex"));
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.PASEO_HOME).toBeUndefined();
  expect(env.PATH?.split(path.delimiter)).not.toContain("/user/bin");
  const isolated = isolateRuntimeNodeEnvironment(env);
  expect(isolated.NODE_OPTIONS).toBe("--no-global-search-paths");
  expect(isolated.NODE_PATH).toBe("");
  expect(isolated.MALLEAF_HOST_NODE_OPTIONS).toBe("--max-old-space-size=2048");
  expect(isolated.MALLEAF_HOST_NODE_PATH).toBe("/host/modules");
});

test("caller-controlled temp settings cannot authorize the real account home or installed state", () => {
  const native = os.userInfo().homedir;
  expect(() => assertAcceptanceBoundary(native, path.join(native, ".malleaf"))).toThrow(
    /account home/,
  );
  expect(() =>
    assertAcceptanceBoundary(
      path.join(native, ".malleaf", "scratch"),
      path.join(native, ".malleaf", "scratch/product"),
    ),
  ).toThrow(/installed product state/);
  const windowsTemp = path.join(native, "AppData/Local/Temp/malleaf-acceptance");
  expect(() =>
    assertAcceptanceBoundary(windowsTemp, path.join(windowsTemp, "product")),
  ).not.toThrow();
});
