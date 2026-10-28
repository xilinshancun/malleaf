import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { loadControllerAuthority, controllerAuthorityFromHash } from "./controller-authority.js";

const roots: string[] = [];
const token = randomBytes(32).toString("hex");
const hash = createHash("sha256").update(token).digest("hex");
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("authority protects every drain mutation and lifecycle stop, independently of drain state", () => {
  const authority = controllerAuthorityFromHash(hash);
  for (const action of ["begin", "end", "commit"] as const) {
    for (const controllerToken of [undefined, "x".repeat(64), randomBytes(32).toString("hex")]) {
      expect(() =>
        authority.assertRequest({
          type: "daemon.quiesce.request",
          requestId: "r",
          action,
          controllerToken,
        }),
      ).toThrow("controller_owned");
    }
    expect(() =>
      authority.assertRequest({
        type: "daemon.quiesce.request",
        requestId: "r",
        action,
        controllerToken: token,
      }),
    ).not.toThrow();
  }
  expect(() =>
    authority.assertRequest({ type: "daemon.quiesce.request", requestId: "r", action: "status" }),
  ).not.toThrow();
  expect(() =>
    authority.assertRequest({ type: "shutdown_server_request", requestId: "r" }),
  ).toThrow("controller_owned");
  expect(() =>
    authority.assertRequest({
      type: "shutdown_server_request",
      requestId: "r",
      controllerToken: token,
    }),
  ).not.toThrow();
  expect(() => authority.assertRequest({ type: "restart_server_request", requestId: "r" })).toThrow(
    "controller_owned",
  );
  for (const request of [
    { type: "set_daemon_config_request", requestId: "r", config: { relay: { enabled: true } } },
    {
      type: "hub.management.daemon.connect.request",
      requestId: "r",
      hubUrl: "https://example.invalid",
      token: "unused",
    },
  ]) {
    // Shape parsing belongs to the wire schema; this directly checks the central classification.
    expect(() =>
      authority.assertRequest(request as Parameters<typeof authority.assertRequest>[0]),
    ).toThrow("controller_owned");
  }
  expect(authority.isAuthorized(token)).toBe(true);
  expect(authority.isAuthorized(undefined)).toBe(false);
});

test("persistent ownership survives manual startup and a worker cannot accept a replaced marker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "controller-authority-"));
  roots.push(root);
  expect(await loadControllerAuthority(root)).toBeUndefined();
  await expect(loadControllerAuthority(root, hash)).rejects.toThrow("missing");
  await mkdir(path.join(root, "runtime"));
  const filename = path.join(root, "runtime/controller-authority.json");
  await writeFile(filename, JSON.stringify({ schemaVersion: 1, tokenHash: hash }));
  expect((await loadControllerAuthority(root))?.isAuthorized(token)).toBe(true);
  await expect(loadControllerAuthority(root, "f".repeat(64))).rejects.toThrow("changed");
  await writeFile(filename, "{");
  await expect(loadControllerAuthority(root)).rejects.toThrow(
    "Invalid controller authority marker",
  );
  await rm(filename);
  await writeFile(path.join(root, "other"), JSON.stringify({ schemaVersion: 1, tokenHash: hash }));
  await symlink(path.join(root, "other"), filename);
  await expect(loadControllerAuthority(root)).rejects.toThrow("regular file");
});
