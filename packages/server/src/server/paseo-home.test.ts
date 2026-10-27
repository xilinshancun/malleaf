import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { resolvePaseoHome } from "./paseo-home.js";
import { createMalleafEnvironment, MALLEAF_FORWARDED_OPTIONS } from "./malleaf/environment.js";
import { DAEMON_SETTING_ENV_KEYS, daemonLaunchEnvironment } from "./config-environment.js";
import { createExternalProcessEnv } from "./paseo-env.js";
import { MALLEAF_INHERITED_ENV_KEYS } from "@getpaseo/protocol/malleaf/product-identity";
describe("resolvePaseoHome", () => {
  test("resolves an explicit daemon home without creating it", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "paseo-home-parent-"));
    const paseoHome = path.join(parent, "home");
    try {
      expect(resolvePaseoHome({ MALLEAF_DAEMON_HOME: paseoHome })).toBe(paseoHome);
      expect(existsSync(paseoHome)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("Malleaf home isolation", () => {
  let fixtureHome: string;

  beforeEach(() => {
    fixtureHome = mkdtempSync(path.join(tmpdir(), "malleaf-home-isolation-"));
    vi.spyOn(os, "homedir").mockReturnValue(fixtureHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(fixtureHome, { recursive: true, force: true });
  });

  test("defaults to a distinct daemon directory without creating it", () => {
    const expected = path.join(fixtureHome, ".malleaf", "daemon");
    expect(resolvePaseoHome({})).toBe(expected);
    expect(existsSync(expected)).toBe(false);
  });

  test("an explicit Malleaf root wins over the hosting agent's Paseo home", () => {
    const root = path.join(fixtureHome, "candidate");
    expect(
      resolvePaseoHome({ MALLEAF_HOME: root, PASEO_HOME: path.join(fixtureHome, ".paseo") }),
    ).toBe(path.join(root, "daemon"));
  });

  test("ignores an inherited Paseo home even for raw resolver callers", () => {
    expect(resolvePaseoHome({ PASEO_HOME: path.join(fixtureHome, ".paseo") })).toBe(
      path.join(fixtureHome, ".malleaf", "daemon"),
    );
    expect(resolvePaseoHome({ PASEO_HOME: path.join(fixtureHome, "custom-host") })).toBe(
      path.join(fixtureHome, ".malleaf", "daemon"),
    );
  });

  test("rejects a Malleaf root nested inside the installed Paseo home", () => {
    expect(() =>
      resolvePaseoHome({ MALLEAF_HOME: path.join(fixtureHome, ".paseo", "beta") }),
    ).toThrow("Malleaf cannot use the installed Paseo home");
  });

  test("rejects symlink aliases even when the final candidate directory is absent", () => {
    const installed = path.join(fixtureHome, ".paseo");
    const alias = path.join(fixtureHome, "alias");
    mkdirSync(installed);
    symlinkSync(installed, alias, process.platform === "win32" ? "junction" : "dir");
    expect(() => resolvePaseoHome({ MALLEAF_HOME: path.join(alias, "new-candidate") })).toThrow(
      "Malleaf cannot use the installed Paseo home",
    );
    expect(existsSync(path.join(installed, "new-candidate"))).toBe(false);
  });

  test("rejects dangling aliases and desktop state", () => {
    const alias = path.join(fixtureHome, "dangling");
    symlinkSync(
      path.join(fixtureHome, ".paseo"),
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() => resolvePaseoHome({ MALLEAF_HOME: path.join(alias, "beta") })).toThrow(
      "installed Paseo home",
    );
    expect(() =>
      resolvePaseoHome({
        MALLEAF_HOME: path.join(fixtureHome, "Library/Application Support/Paseo"),
      }),
    ).toThrow("installed Paseo home");
  });

  test("discards hosting configuration and only forwards namespaced options", () => {
    const inherited = {
      PATH: "/usr/bin",
      PASEO_HOME: path.join(fixtureHome, ".paseo"),
      PASEO_HOST: "localhost:6767",
      PASEO_CLI: "/Applications/Paseo.app/paseo",
      PASEO_PASSWORD: "host-secret",
      PASEO_ACTIVITY_TOKEN: "host-token",
      PASEO_TERMINAL_ACTIVITY_URL: "http://localhost:6767/activity",
      PASEO_DEV_MANAGED_HOME: "1",
      PASEO_DEV_SEED_HOME: fixtureHome,
      PASEO_LOCAL_MODELS_DIR: path.join(fixtureHome, ".paseo/models"),
      PASEO_FUTURE_OPTION: "must not leak",
      MALLEAF_LOG_LEVEL: "debug",
    };
    const env = createMalleafEnvironment(inherited);
    expect(env.PASEO_HOME).toBe(path.join(fixtureHome, ".malleaf/daemon"));
    expect(env.PASEO_LOCAL_MODELS_DIR).toBe(path.join(fixtureHome, ".malleaf/models/local-speech"));
    expect(env.PASEO_LOG_LEVEL).toBe("debug");
    for (const key of Object.keys(inherited).filter(
      (candidate) =>
        candidate.startsWith("PASEO_") &&
        candidate !== "PASEO_HOME" &&
        candidate !== "PASEO_LOCAL_MODELS_DIR",
    )) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.PATH).toBe("/usr/bin");
    expect(createMalleafEnvironment(env)).toEqual(env);
    expect(createMalleafEnvironment(createMalleafEnvironment({}))).toEqual(
      createMalleafEnvironment({}),
    );
  });

  test("rejects reuse of a custom inherited home before any directory is created", () => {
    const hostHome = path.join(fixtureHome, "custom-paseo");
    expect(() =>
      createMalleafEnvironment({ PASEO_HOME: hostHome, MALLEAF_HOME: hostHome }),
    ).toThrow("installed Paseo home");
    expect(existsSync(hostHome)).toBe(false);
  });

  test("development defaults are checkout-specific and cannot bind all interfaces", () => {
    const developmentRoot = path.join(fixtureHome, "checkout");
    const env = createMalleafEnvironment({}, { developmentRoot });
    expect(env.PASEO_HOME).toContain(path.join(fixtureHome, ".malleaf-dev"));
    expect(env.PASEO_HOME).not.toContain(developmentRoot);
    expect(env.PASEO_LISTEN).toMatch(/^127\.0\.0\.1:[34]\d{4}$/);
    expect(() =>
      createMalleafEnvironment({}, { developmentRoot, developmentListen: "0.0.0.0:6778" }),
    ).toThrow("127.0.0.1");
  });

  test("test launch guards reject the installed Malleaf home even after HOME redirection", () => {
    const installed = path.join(os.userInfo().homedir, ".malleaf");
    for (const flags of [{ MALLEAF_TEST: "1" }, { VITEST: "true" }, { E2E_DAEMON_PORT: "23456" }]) {
      expect(() => createMalleafEnvironment({ ...flags, MALLEAF_HOME: installed })).toThrow(
        "disposable Malleaf state",
      );
      expect(() =>
        createMalleafEnvironment({ ...flags, MALLEAF_DAEMON_HOME: path.join(installed, "daemon") }),
      ).toThrow("disposable Malleaf state");
      expect(createMalleafEnvironment(flags).MALLEAF_HOME).toBe(path.join(fixtureHome, ".malleaf"));
    }
  });

  test("development inside a protected worktree ignores the parent Malleaf runtime", () => {
    const parent = path.join(fixtureHome, ".malleaf");
    const parentHome = path.join(parent, "data/current");
    mkdirSync(parentHome, { recursive: true });
    const config = path.join(parentHome, "config.json");
    writeFileSync(config, '{"version":1,"daemon":{"listen":"127.0.0.1:6777"}}');
    const before = readFileSync(config);
    const checkout = path.join(fixtureHome, ".paseo/worktrees/candidate");
    const env = {
      ...process.env,
      HOME: fixtureHome,
      USERPROFILE: fixtureHome,
      MALLEAF_HOME: parent,
      MALLEAF_DAEMON_HOME: parentHome,
      MALLEAF_LISTEN: "127.0.0.1:6777",
      PASEO_HOME: parentHome,
      MALLEAF_HOST_PASEO_HOME: "",
    };
    const repository = path.resolve(import.meta.dirname, "../../../..");
    const generated = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--conditions=source",
          "--import",
          path.join(repository, "node_modules/tsx/dist/loader.mjs"),
          path.join(repository, "scripts/malleaf/development-environment.mts"),
          checkout,
          "--prepare",
          "--json",
        ],
        { env, encoding: "utf8" },
      ),
    );
    expect(generated.MALLEAF_DAEMON_HOME).not.toBe(parentHome);
    expect(generated.PASEO_LISTEN).not.toBe("127.0.0.1:6777");
    expect(generated.MALLEAF_HOME).toContain(path.join(fixtureHome, ".malleaf-dev"));
    expect(readFileSync(config)).toEqual(before);
    expect(
      JSON.parse(readFileSync(path.join(generated.MALLEAF_DAEMON_HOME, "config.json"), "utf8"))
        .daemon.listen,
    ).toBe(generated.PASEO_LISTEN);
  });

  test("Malleaf shim signals survive while identically named upstream signals do not", () => {
    const env = createMalleafEnvironment({
      MALLEAF_NODE_ENV: "production",
      MALLEAF_CLI: "/app/malleaf",
      MALLEAF_DESKTOP_MANAGED: "1",
      MALLEAF_DESKTOP_CLI: "1",
      MALLEAF_HOST: "chosen:12345",
      PASEO_NODE_ENV: "development",
      PASEO_CLI: "/app/paseo",
      PASEO_HOME: "/foreign/home",
    });
    expect(env.PASEO_CLI).toBe("/app/malleaf");
    expect(env.PASEO_NODE_ENV).toBe("production");
    expect(env.PASEO_DESKTOP_MANAGED).toBe("1");
    expect(env.PASEO_DESKTOP_CLI).toBe("1");
    expect(env.PASEO_HOST).toBe("chosen:12345");
    expect(env.PASEO_HOME).toBeUndefined();
  });

  test("all forwarded runtime controls stop at child boundaries and development drops session context", () => {
    const names = [
      ...MALLEAF_FORWARDED_OPTIONS,
      ...DAEMON_SETTING_ENV_KEYS.filter((key) => key.startsWith("PASEO_")).map((key) =>
        key.slice(6),
      ),
    ];
    const inherited = Object.fromEntries(names.map((name) => [`MALLEAF_${name}`, "parent-value"]));
    inherited.MALLEAF_AGENT_ID = "parent-agent";
    inherited.PASEO_AGENT_ID = "parent-agent";
    const external = createExternalProcessEnv(inherited);
    for (const name of names) {
      const key = `MALLEAF_${name}`;
      if (!MALLEAF_INHERITED_ENV_KEYS.includes(key)) expect(external[key], key).toBeUndefined();
    }
    const development = createMalleafEnvironment(inherited, {
      developmentRoot: path.join(fixtureHome, "candidate"),
    });
    for (const key of [
      "SERVER_ID",
      "AGENT_ID",
      "ACTIVITY_TOKEN",
      "TERMINAL_ACTIVITY_URL",
      "ELECTRON_REMOTE_DEBUGGING_PORT",
    ]) {
      expect(development[`MALLEAF_${key}`], key).toBeUndefined();
      expect(development[`PASEO_${key}`], key).toBeUndefined();
    }
    const daemon = daemonLaunchEnvironment({
      env: inherited,
      home: path.join(fixtureHome, "daemon"),
      mode: "deployment",
    });
    expect(daemon.PASEO_AGENT_ID).toBeUndefined();
    expect(daemon.MALLEAF_AGENT_ID).toBeUndefined();
  });

  test.skipIf(process.platform === "win32")(
    "an absolute launcher uses its own checkout from a different working directory",
    () => {
      const repository = path.resolve(import.meta.dirname, "../../../..");
      const parentHome = path.join(fixtureHome, "parent");
      const env = {
        ...process.env,
        HOME: fixtureHome,
        USERPROFILE: fixtureHome,
        MALLEAF_HOME: parentHome,
        MALLEAF_DAEMON_HOME: path.join(parentHome, "daemon"),
        MALLEAF_SERVER_ID: "parent-server",
        MALLEAF_ACTIVITY_TOKEN: "parent-token",
      };
      const result = JSON.parse(
        execFileSync(
          "bash",
          [
            path.join(repository, "scripts/dev-home.sh"),
            process.execPath,
            "-e",
            "process.stdout.write(JSON.stringify(process.env))",
          ],
          { cwd: fixtureHome, env, encoding: "utf8" },
        ),
      );
      const expected = createMalleafEnvironment(env, { developmentRoot: repository });
      expect(result.MALLEAF_DAEMON_HOME).toBe(expected.MALLEAF_DAEMON_HOME);
      expect(result.MALLEAF_DAEMON_ENTRY).toBe(
        path.join(repository, "packages/server/scripts/supervisor-entrypoint.ts"),
      );
      expect(result.MALLEAF_SERVER_ID).toBeUndefined();
      expect(result.MALLEAF_ACTIVITY_TOKEN).toBeUndefined();
      expect(existsSync(parentHome)).toBe(false);
    },
  );

  test.skipIf(process.platform !== "darwin" && process.platform !== "win32")(
    "rejects case aliases of an absent installed path",
    () => {
      expect(() =>
        resolvePaseoHome({ MALLEAF_HOME: path.join(fixtureHome, ".PASEO", "candidate") }),
      ).toThrow("installed Paseo home");
    },
  );
});
