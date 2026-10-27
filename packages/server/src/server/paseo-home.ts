import { resolveMalleafDaemonHome } from "./malleaf/home.js";

export function resolvePaseoHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolveMalleafDaemonHome(env);
}
