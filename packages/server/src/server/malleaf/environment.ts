import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import {
  malleafIdentity,
  MALLEAF_SESSION_CONTEXT_OPTIONS,
} from "@getpaseo/protocol/malleaf/product-identity";
import { assertMalleafHomeIsolated, resolveMalleafHome, canonicalMalleafPath } from "./home.js";
import { DAEMON_SETTING_ENV_KEYS } from "../config-environment.js";

export { assertMalleafHomeIsolated };

// RFC-0001: Public entry points discard the hosting Paseo environment. Only
// explicitly namespaced Malleaf options are translated for upstream internals.
export const MALLEAF_FORWARDED_OPTIONS = [
  ...MALLEAF_SESSION_CONTEXT_OPTIONS,
  "HUB_API_KEY",
  "HUB_URL",
  "HOST",
  "LISTEN",
  "PASSWORD",
  "NODE_ENV",
  "NODE_INSPECT",
  "CORS_ORIGINS",
  "LOG_LEVEL",
  "LOG_FORMAT",
  "LOCAL_MODELS_DIR",
  "ELECTRON_USER_DATA_DIR",
  "DAEMON_ENDPOINT",
  "DEV_ROOT",
  "TEST_APP_NAME",
  "SKIP_DEV_SERVER_BUILD",
  "ELECTRON_FLAGS",
  "CLI",
  "DESKTOP_MANAGED",
  "DESKTOP_CLI",
  "DESKTOP_SANDBOX_REASON",
  "DISABLE_SINGLE_INSTANCE_LOCK",
  "DEBUG",
  "DESKTOP_WINDOW_CONTROLS",
  "ELECTRON_REMOTE_DEBUGGING_PORT",
  "DESKTOP_SMOKE_ARTIFACT_DIR",
  "LOCAL_SPEECH_AUTO_DOWNLOAD",
  "SERVER_ID",
  "PAIRING_QR",
] as const;

interface DevelopmentOptions {
  developmentRoot?: string;
  developmentListen?: string;
}

function applyDevelopmentDefaults(env: NodeJS.ProcessEnv, options: DevelopmentOptions): void {
  const developmentKey = options.developmentRoot
    ? createHash("sha256")
        .update(canonicalMalleafPath(path.resolve(options.developmentRoot)))
        .digest("hex")
        .slice(0, 16)
    : undefined;
  if (developmentKey) {
    // A customization agent inherits its parent's MALLEAF_* values too.
    // Keep development state outside both the parent home and its worktrees.
    env.MALLEAF_HOME = path.join(os.homedir(), ".malleaf-dev", developmentKey);
    delete env.MALLEAF_DAEMON_HOME;
    delete env.MALLEAF_HOST;
    env.MALLEAF_LISTEN =
      options.developmentListen ??
      `127.0.0.1:${30000 + (Number.parseInt(developmentKey.slice(0, 6), 16) % 20000)}`;
  }
}

function assertDisposableTestHome(input: NodeJS.ProcessEnv, root: string, home: string): void {
  if (
    input.MALLEAF_TEST === "1" ||
    input.VITEST ||
    input.NODE_ENV === "test" ||
    input.E2E_DAEMON_PORT
  ) {
    const installedMalleaf = path.join(os.userInfo().homedir, malleafIdentity.homeDirectory);
    try {
      assertMalleafHomeIsolated(root, [installedMalleaf]);
      assertMalleafHomeIsolated(home, [installedMalleaf]);
    } catch {
      throw new Error(
        "Test launches must select disposable Malleaf state; the installed Malleaf home is protected.",
      );
    }
  }
}

export function createMalleafEnvironment(
  input: NodeJS.ProcessEnv,
  options: DevelopmentOptions = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(input).filter(
      ([key]) =>
        !key.startsWith("PASEO_") && !(options.developmentRoot && key.startsWith("MALLEAF_")),
    ),
  );
  applyDevelopmentDefaults(env, options);
  const root = resolveMalleafHome(env);
  const home = path.resolve(env.MALLEAF_DAEMON_HOME ?? path.join(root, "daemon"));
  // A second boundary (dev launcher -> CLI) must keep the original host path,
  // rather than mistake its own translated PASEO_HOME for a foreign instance.
  const foreignPaseoHome =
    input.PASEO_HOME === input.MALLEAF_DAEMON_HOME ? undefined : input.PASEO_HOME;
  const hostHome = input.MALLEAF_HOST_PASEO_HOME || foreignPaseoHome;
  const protectedHomes = [hostHome, foreignPaseoHome].filter((value): value is string =>
    Boolean(value),
  );
  if (options.developmentRoot) {
    for (const inherited of [input.MALLEAF_HOME, input.MALLEAF_DAEMON_HOME, input.PASEO_HOME]) {
      if (inherited && path.resolve(inherited) !== root && path.resolve(inherited) !== home)
        protectedHomes.push(inherited);
    }
  }
  assertMalleafHomeIsolated(root, protectedHomes);
  assertMalleafHomeIsolated(home, protectedHomes);
  assertDisposableTestHome(input, root, home);
  if (env.MALLEAF_ELECTRON_USER_DATA_DIR)
    assertMalleafHomeIsolated(env.MALLEAF_ELECTRON_USER_DATA_DIR, protectedHomes);
  env.MALLEAF_HOME = root;
  env.MALLEAF_DAEMON_HOME = home;
  env.MALLEAF_HOST_PASEO_HOME = hostHome ?? "";
  if (!env.MALLEAF_HOST) env.PASEO_HOME = home;
  const forwarded = new Set<string>([
    ...MALLEAF_FORWARDED_OPTIONS,
    ...DAEMON_SETTING_ENV_KEYS.filter((key) => key.startsWith("PASEO_")).map((key) => key.slice(6)),
  ]);
  for (const name of forwarded) {
    if (env[`MALLEAF_${name}`] !== undefined) env[`PASEO_${name}`] = env[`MALLEAF_${name}`];
  }
  if (options.developmentRoot) {
    env.MALLEAF_DEV_ROOT = options.developmentRoot;
    env.MALLEAF_DAEMON_ENTRY = path.join(
      options.developmentRoot,
      "packages/server/scripts/supervisor-entrypoint.ts",
    );
    env.PASEO_DEV_ROOT = options.developmentRoot;
    if (!/^127\.0\.0\.1:\d+$/.test(env.MALLEAF_LISTEN!)) {
      throw new Error("Malleaf development services must listen on 127.0.0.1:<port>.");
    }
    env.PASEO_LISTEN = env.MALLEAF_LISTEN;
    env.PASEO_DEV_MANAGED_HOME = "1";
  }
  env.PASEO_LOCAL_MODELS_DIR ??= path.join(root, "models", "local-speech");
  return env;
}

export function initializeMalleafEnvironment(): void {
  const env = createMalleafEnvironment(process.env);
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PASEO_")) delete process.env[key];
  }
  Object.assign(
    process.env,
    Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)),
  );
}
