import { mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { readPersistedConfig } from "@getpaseo/server/configuration";
import { createMalleafEnvironment } from "@getpaseo/server/malleaf-runtime";
import { BUILTIN_PROVIDER_IDS } from "@getpaseo/protocol/provider-manifest";
import { preparePreflight } from "./preflight.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test.each([false, true])(
  "preflight owns empty disposable state and exposes only the requested mock provider: %s",
  async (mockProvider) => {
    const scratchRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "preflight-test-")));
    roots.push(scratchRoot);
    const slotDirectory = path.join(scratchRoot, "versions", "a".repeat(64));
    const prepared = await preparePreflight({
      scratchRoot,
      slotDirectory,
      mockProvider,
      environment: {
        PASEO_HOME: "/parent-paseo",
        MALLEAF_HOME: "/parent-malleaf",
        MALLEAF_HOST: "127.0.0.1:6767",
        NODE_OPTIONS: "--inspect",
        OPENAI_API_KEY: "private",
        CODEX_HOME: "/real-provider",
        PATH: "/private-bin",
        npm_config_cache: "/real-cache",
        SystemRoot: "C:\\Windows",
      },
    });
    const env = createMalleafEnvironment(prepared.env);
    expect(env.PASEO_HOME).toBe(prepared.daemonHome);
    expect(env.PASEO_LISTEN).toBe("127.0.0.1:0");
    expect(env.PASEO_NODE_ENV).toBe(mockProvider ? "development" : "production");
    expect(env.MALLEAF_SLOT_MANIFEST).toBe(path.join(slotDirectory, "malleaf.json"));
    for (const key of [
      "OPENAI_API_KEY",
      "NODE_OPTIONS",
      "PASEO_HOST",
      "MALLEAF_HOST",
      "npm_config_cache",
    ])
      expect(env[key]).toBeUndefined();
    expect(env.PATH).not.toContain("private-bin");
    expect(await readdir(prepared.daemonHome)).toEqual(["config.json"]);
    expect((await stat(env.CODEX_HOME!)).isDirectory()).toBe(true);
    expect((await stat(env.CLAUDE_CONFIG_DIR!)).isDirectory()).toBe(true);
    const config = readPersistedConfig(prepared.daemonHome);
    expect(config.daemon).toMatchObject({
      listen: "127.0.0.1:0",
      relay: { enabled: false },
      enableTerminalAgentHooks: false,
    });
    expect(config.pluginsEnabled).toBe(false);
    for (const id of BUILTIN_PROVIDER_IDS)
      expect(config.agents?.providers?.[id]).toMatchObject({ enabled: false });
    expect(config.agents?.providers?.mock).toEqual(mockProvider ? { enabled: true } : undefined);
    await prepared.dispose();
    await expect(stat(prepared.root)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
