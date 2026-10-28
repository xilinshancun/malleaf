import path from "node:path";

// This entry only boots disposable mock epochs. User activation needs its own
// explicit environment contract; inherited MALLEAF/PASEO controls are excluded.
export function acceptanceBootEnvironment(options: {
  root: string;
  home: string;
  fakeHome: string;
  inherited: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "ComSpec", "WINDIR", "LANG", "LC_ALL"]) {
    const key = Object.keys(options.inherited).find(
      (candidate) => candidate.toLowerCase() === name.toLowerCase(),
    );
    if (key) env[name] = options.inherited[key];
  }
  const systemPaths =
    process.platform === "win32"
      ? [path.join(env.SystemRoot ?? "C:\\Windows", "System32")]
      : ["/usr/bin", "/bin"];
  return {
    ...env,
    PATH: [path.dirname(process.execPath), ...systemPaths].join(path.delimiter),
    HOME: options.fakeHome,
    USERPROFILE: options.fakeHome,
    APPDATA: path.join(options.fakeHome, "AppData"),
    LOCALAPPDATA: path.join(options.fakeHome, "AppData"),
    XDG_CONFIG_HOME: path.join(options.fakeHome, ".config"),
    CLAUDE_CONFIG_DIR: path.join(options.fakeHome, ".claude"),
    CODEX_HOME: path.join(options.fakeHome, ".codex"),
    TMPDIR: path.join(options.root, "tmp"),
    TMP: path.join(options.root, "tmp"),
    TEMP: path.join(options.root, "tmp"),
    MALLEAF_HOME: options.home,
    MALLEAF_LISTEN: "127.0.0.1:0",
    MALLEAF_NODE_ENV: "development",
    MALLEAF_RELAY_ENABLED: "false",
    MALLEAF_WEB_UI_ENABLED: "false",
    MALLEAF_LOCAL_SPEECH_AUTO_DOWNLOAD: "false",
    MALLEAF_LOCAL_MODELS_DIR: path.join(options.home, "models"),
    MALLEAF_TEST: "1",
    // Adapter immediately re-isolates Node and stores these values for external
    // children. They never become the controller's own process environment.
    NODE_OPTIONS: options.inherited.MALLEAF_HOST_NODE_OPTIONS || undefined,
    NODE_PATH: options.inherited.MALLEAF_HOST_NODE_PATH || undefined,
  };
}
