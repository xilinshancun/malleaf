// RFC-0001: Keep fork identity separate from upstream protocol and package versions.
export const malleafIdentity = {
  name: "Malleaf",
  slug: "malleaf",
  cliName: "malleaf",
  urlScheme: "malleaf",
  desktopAppId: "io.github.xilinshancun.malleaf",
  homeDirectory: ".malleaf",
  daemonDirectory: "daemon",
  daemonPort: 6777,
  developmentDaemonPort: 6778,
  repositoryOwner: "xilinshancun",
  repositoryName: "malleaf",
  globalHarnessIntegrations: false,
} as const;

export const malleafRepositoryUrl = `https://github.com/${malleafIdentity.repositoryOwner}/${malleafIdentity.repositoryName}`;

export const malleafDaemonEndpoint = `127.0.0.1:${malleafIdentity.daemonPort}`;

// Runtime launch controls must not become configuration for an agent's children.
export const MALLEAF_RUNTIME_CONTROL_KEYS = [
  "MALLEAF_SERVER_ID",
  "MALLEAF_NODE_ENV",
  "MALLEAF_DESKTOP_MANAGED",
  "MALLEAF_DESKTOP_CLI",
  "MALLEAF_DAEMON_ENTRY",
  "MALLEAF_CANDIDATE",
  "MALLEAF_LISTEN",
  "MALLEAF_DEV_ROOT",
  "MALLEAF_DESKTOP_SANDBOX_REASON",
  "MALLEAF_ELECTRON_FLAGS",
  "MALLEAF_ELECTRON_USER_DATA_DIR",
  "MALLEAF_DISABLE_SINGLE_INSTANCE_LOCK",
  "MALLEAF_TEST_APP_NAME",
  "MALLEAF_DAEMON_ENDPOINT",
  "MALLEAF_SKIP_DEV_SERVER_BUILD",
] as const;

// Context attached by this daemon to its own agents and terminals. Public
// launchers only accept the namespaced copy, never a hosting Paseo's context.
export const MALLEAF_SESSION_CONTEXT_OPTIONS = [
  "AGENT_ID",
  "WORKSPACE_ID",
  "TERMINAL_ID",
  "ACTIVITY_TOKEN",
  "TERMINAL_ACTIVITY_URL",
] as const;

// All other namespaced variables, including future launch options, stop at
// the external-process boundary. Ordinary CLI calls retain their parent target.
export const MALLEAF_INHERITED_ENV_KEYS = [
  "MALLEAF_HOME",
  "MALLEAF_DAEMON_HOME",
  "MALLEAF_HOST_PASEO_HOME",
  "MALLEAF_CLI",
  ...MALLEAF_SESSION_CONTEXT_OPTIONS.map((name) => `MALLEAF_${name}`),
] as const;

export function isMalleafRuntimeControl(key: string): boolean {
  return key.startsWith("MALLEAF_") && !MALLEAF_INHERITED_ENV_KEYS.includes(key);
}
