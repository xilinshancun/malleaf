import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MALLEAF_RUNTIME_CONTROL_KEYS } from "@getpaseo/protocol/malleaf/product-identity";
import {
  buildSelfNodeCommand,
  createExternalCommandProcessEnv,
  createExternalProcessEnv,
  createPaseoInternalEnv,
  resolvePaseoNodeEnv,
} from "./paseo-env.js";

describe("paseo env contract", () => {
  const ELECTRON_RUN_AS_NODE = "ELECTRON_RUN_AS_NODE";
  const PASEO_NODE_ENV = "PASEO_NODE_ENV";
  const baseEnv = {
    MALLEAF_SLOT_MANIFEST: "/parent-slot/malleaf.json",
    MALLEAF_BOOT_DRAIN_ID: "parent-runtime-token",
    MALLEAF_CONTROLLER_TOKEN: "must-not-be-inherited",
    MALLEAF_CONTROLLER_AUTHORITY_HASH: "controller-hash",
    [ELECTRON_RUN_AS_NODE]: "1",
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    NODE_ENV: "development",
    PATH: "/usr/bin",
    PASEO_AGENT_ID: "agent-123",
    PASEO_DESKTOP_MANAGED: "1",
    [PASEO_NODE_ENV]: "production",
    PASEO_SUPERVISED: "1",
    ESBUILD_BINARY_PATH: "/Applications/Paseo.app/Contents/Resources/app.asar.unpacked/esbuild",
  };
  const runtimeControlEnvKeys = [
    "ELECTRON_RUN_AS_NODE",
    "PASEO_NODE_ENV",
    "PASEO_DESKTOP_MANAGED",
    "PASEO_SUPERVISED",
    "ELECTRON_NO_ATTACH_CONSOLE",
    "ESBUILD_BINARY_PATH",
    "MALLEAF_SLOT_MANIFEST",
    "MALLEAF_BOOT_DRAIN_ID",
    "MALLEAF_CONTROLLER_TOKEN",
    "MALLEAF_CONTROLLER_AUTHORITY_HASH",
  ] as const;

  test("builds internal daemon child env by preserving pass-through and control vars", () => {
    const env = createPaseoInternalEnv(baseEnv);

    expect(env).toMatchObject({
      [ELECTRON_RUN_AS_NODE]: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      NODE_ENV: "development",
      PATH: "/usr/bin",
      PASEO_DESKTOP_MANAGED: "1",
      [PASEO_NODE_ENV]: "production",
      PASEO_SUPERVISED: "1",
      PASEO_AGENT_ID: "agent-123",
    });
  });

  test("builds external process env by scrubbing runtime control vars after overlays", () => {
    const env = createExternalProcessEnv(baseEnv, {
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      ELECTRON_RUN_AS_NODE: "0",
      EXTRA_VALUE: "from-overlay",
      PASEO_DESKTOP_MANAGED: "1",
      PASEO_NODE_ENV: "test",
      PASEO_SUPERVISED: "1",
      PATH: "/custom/bin",
    });

    for (const key of runtimeControlEnvKeys) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.NODE_ENV).toBe("development");
    expect(env.PASEO_AGENT_ID).toBe("agent-123");
    expect(env.PATH).toBe("/custom/bin");
  });

  test("applies non-control overlays to external process env", () => {
    const env = createExternalProcessEnv(baseEnv, { PATH: "/custom/bin" }, { CUSTOM: "value" });

    expect(env.CUSTOM).toBe("value");
    expect(env.NODE_ENV).toBe("development");
    expect(env.PATH).toBe("/custom/bin");
  });

  test("restores host Node settings only for external children and retains explicit overlays", () => {
    const managed = {
      ...baseEnv,
      NODE_OPTIONS: "--no-global-search-paths",
      NODE_PATH: "",
      MALLEAF_HOST_NODE_OPTIONS: "--max-old-space-size=2048 --use-openssl-ca",
      MALLEAF_HOST_NODE_PATH: "/host/node_modules",
    };
    expect(createPaseoInternalEnv(managed)).toEqual(managed);
    const external = createExternalProcessEnv(managed);
    expect(external.NODE_OPTIONS).toBe(managed.MALLEAF_HOST_NODE_OPTIONS);
    expect(external.NODE_PATH).toBe(managed.MALLEAF_HOST_NODE_PATH);
    expect(external.MALLEAF_HOST_NODE_OPTIONS).toBeUndefined();
    expect(external.MALLEAF_HOST_NODE_PATH).toBeUndefined();
    expect(
      createExternalProcessEnv(managed, { NODE_OPTIONS: "--trace-warnings" }).NODE_OPTIONS,
    ).toBe("--trace-warnings");
    expect(createExternalProcessEnv(managed, { NODE_PATH: undefined }).NODE_PATH).toBeUndefined();
    expect(managed.NODE_OPTIONS).toBe("--no-global-search-paths");
  });

  test("does not leak the slot's Node restrictions when the host had no overrides", () => {
    const external = createExternalProcessEnv({
      NODE_OPTIONS: "--no-global-search-paths",
      NODE_PATH: "",
      MALLEAF_HOST_NODE_OPTIONS: "",
      MALLEAF_HOST_NODE_PATH: "",
    });
    expect(external.NODE_OPTIONS).toBeUndefined();
    expect(external.NODE_PATH).toBeUndefined();
    expect(createExternalProcessEnv({ NODE_OPTIONS: "--trace-warnings" }).NODE_OPTIONS).toBe(
      "--trace-warnings",
    );
  });

  test("an external Node child can load the host preload while an internal child cannot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "malleaf-node-env-"));
    try {
      const preload = path.join(root, "host-preload.cjs");
      await writeFile(preload, "process.env.MALLEAF_NODE_TEST_PRELOADED = 'yes';");
      const managed = {
        ...process.env,
        NODE_OPTIONS: "--no-global-search-paths",
        NODE_PATH: "",
        MALLEAF_HOST_NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
        MALLEAF_HOST_NODE_PATH: path.join(root, "host-modules"),
      };
      const probe = (env: NodeJS.ProcessEnv) =>
        JSON.parse(
          execFileSync(
            process.execPath,
            [
              "-p",
              "JSON.stringify({preloaded:process.env.MALLEAF_NODE_TEST_PRELOADED,path:process.env.NODE_PATH})",
            ],
            { env, cwd: root, encoding: "utf8" },
          ),
        );
      expect(probe(createPaseoInternalEnv(managed))).toEqual({ path: "" });
      expect(probe(createExternalProcessEnv(managed))).toEqual({
        preloaded: "yes",
        path: managed.MALLEAF_HOST_NODE_PATH,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("agent children retain their parent target but never inherit runtime launch controls", () => {
    const controls = Object.fromEntries(
      MALLEAF_RUNTIME_CONTROL_KEYS.map((key) => [key, "parent-control"]),
    );
    const env = createExternalProcessEnv(
      { ...baseEnv, ...controls, MALLEAF_DAEMON_HOME: "/parent/daemon" },
      controls,
    );
    for (const key of MALLEAF_RUNTIME_CONTROL_KEYS) expect(env[key]).toBeUndefined();
    expect(env.MALLEAF_DAEMON_HOME).toBe("/parent/daemon");
    expect(env.MALLEAF_AGENT_ID).toBe("agent-123");
    const cleared = createExternalProcessEnv(env, { PASEO_AGENT_ID: undefined });
    expect(cleared.MALLEAF_AGENT_ID).toBeUndefined();
  });

  test("builds external command env without process.execPath special-casing", () => {
    const env = createExternalCommandProcessEnv(process.execPath, baseEnv, {
      ELECTRON_RUN_AS_NODE: "0",
      PASEO_NODE_ENV: "test",
    });

    expect(env[ELECTRON_RUN_AS_NODE]).toBeUndefined();
    expect(env.NODE_ENV).toBe("development");
    expect(env.PASEO_AGENT_ID).toBe("agent-123");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined();
    expect(env.PASEO_DESKTOP_MANAGED).toBeUndefined();
    expect(env[PASEO_NODE_ENV]).toBeUndefined();
    expect(env.PASEO_SUPERVISED).toBeUndefined();
  });

  test("builds self node command with Electron node mode", () => {
    const command = buildSelfNodeCommand(["script.js"], {
      CUSTOM: "value",
    });

    expect(command.command).toBe(process.execPath);
    expect(command.args).toEqual(["script.js"]);
    expect(command.env[ELECTRON_RUN_AS_NODE]).toBe("1");
    expect(command.env.CUSTOM).toBe("value");
    expect(command.env.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined();
    expect(command.env.PASEO_DESKTOP_MANAGED).toBeUndefined();
    expect(command.env[PASEO_NODE_ENV]).toBeUndefined();
    expect(command.env.PASEO_SUPERVISED).toBeUndefined();
  });

  test("does not add Electron node mode for non-execPath commands", () => {
    const env = createExternalCommandProcessEnv("node", baseEnv, {
      ELECTRON_RUN_AS_NODE: "1",
    });

    expect(env[ELECTRON_RUN_AS_NODE]).toBeUndefined();
  });

  test("does not use user NODE_ENV as Paseo runtime mode", () => {
    expect(resolvePaseoNodeEnv({ NODE_ENV: "development" })).toBeUndefined();
    expect(resolvePaseoNodeEnv({ NODE_ENV: "development", PASEO_NODE_ENV: "production" })).toBe(
      "production",
    );
    expect(resolvePaseoNodeEnv({ NODE_ENV: "test", PASEO_NODE_ENV: "local" })).toBeUndefined();
  });
});
