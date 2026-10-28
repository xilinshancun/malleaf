import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { SessionInboundMessage } from "@getpaseo/protocol/messages";

export const CONTROLLER_AUTHORITY_FILE = "controller-authority.json";
const hashPattern = /^[a-f0-9]{64}$/;

export class ControllerOwnedError extends Error {
  readonly code = "controller_owned";
  constructor() {
    super("controller_owned: This runtime is managed by the Malleaf controller");
    this.name = "ControllerOwnedError";
  }
}

export function controllerTokenHash(token: string): string {
  if (!hashPattern.test(token)) throw new ControllerOwnedError();
  return createHash("sha256").update(token).digest("hex");
}

export function controllerAuthorityFromHash(tokenHash: string) {
  if (!hashPattern.test(tokenHash)) throw new Error("Invalid controller authority hash");
  const expected = Buffer.from(tokenHash, "hex");
  const isAuthorized = (token: string | undefined) =>
    typeof token === "string" &&
    hashPattern.test(token) &&
    timingSafeEqual(expected, Buffer.from(controllerTokenHash(token), "hex"));
  return {
    tokenHash,
    isAuthorized,
    assertRequest(message: SessionInboundMessage) {
      switch (message.type) {
        case "set_daemon_config_request":
        case "hub.management.daemon.connect.request":
        case "hub.management.daemon.permissions.update.request":
        case "restart_server_request":
        case "daemon.update.request":
        case "daemon.config.reload.request":
        case "daemon.get_pairing_offer.request":
          throw new ControllerOwnedError();
        case "shutdown_server_request":
          if (!isAuthorized(message.controllerToken)) throw new ControllerOwnedError();
          break;
        case "daemon.quiesce.request":
          if (message.action !== "status" && !isAuthorized(message.controllerToken))
            throw new ControllerOwnedError();
          break;
        case "daemon.get_status.request":
          break;
        default:
          // New daemon control RPCs require an explicit policy here.
          if (message.type.startsWith("daemon.")) throw new ControllerOwnedError();
      }
    },
  };
}
export type ControllerAuthority = ReturnType<typeof controllerAuthorityFromHash>;

function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

// Absence preserves standalone daemon behavior. An expected hash pins ownership
// across supervisor/worker restarts; removing or replacing its marker fails closed.
export async function loadControllerAuthority(
  home: string,
  expectedHash?: string,
): Promise<ControllerAuthority | undefined> {
  const directory = path.join(home, "runtime");
  const filename = path.join(directory, CONTROLLER_AUTHORITY_FILE);
  let contents: string;
  try {
    if (!(await lstat(directory)).isDirectory())
      throw new Error("Controller runtime must be a real directory");
    if (!(await lstat(filename)).isFile())
      throw new Error("Controller authority marker must be a regular file");
    contents = await readFile(filename, "utf8");
  } catch (error) {
    if (!missing(error)) throw error;
    if (expectedHash !== undefined)
      throw new Error("Controller authority marker is missing", { cause: error });
    return undefined;
  }
  let tokenHash: string;
  try {
    const value = JSON.parse(contents);
    if (
      value?.schemaVersion !== 1 ||
      typeof value.tokenHash !== "string" ||
      !hashPattern.test(value.tokenHash)
    )
      throw new Error("Unsupported marker shape");
    tokenHash = value.tokenHash;
  } catch (error) {
    throw new Error("Invalid controller authority marker", { cause: error });
  }
  if (expectedHash !== undefined && tokenHash !== expectedHash)
    throw new Error("Controller authority marker changed since supervisor launch");
  return controllerAuthorityFromHash(tokenHash);
}

export async function assertHomeNotControllerOwned(home: string): Promise<void> {
  // Invalid markers also throw; never fall back to unmanaged lifecycle actions.
  if (await loadControllerAuthority(home)) throw new ControllerOwnedError();
}
