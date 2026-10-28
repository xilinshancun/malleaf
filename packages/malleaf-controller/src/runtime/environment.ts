// Slot code must not load host preloads or global packages. Only external
// children restore these values through the daemon's process-env boundary.
export function isolateRuntimeNodeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...environment,
    MALLEAF_CONTROLLER_TOKEN: undefined,
    MALLEAF_HOST_NODE_OPTIONS: environment.NODE_OPTIONS ?? "",
    MALLEAF_HOST_NODE_PATH: environment.NODE_PATH ?? "",
    NODE_OPTIONS: "--no-global-search-paths",
    NODE_PATH: "",
  };
}
