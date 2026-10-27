import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { afterEach, expect, test } from "vitest";
import { acquireControlLease, identifyController } from "./lease.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "malleaf-lease-"));
  roots.push(home);
  const reservation = net.createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  return { port: address.port, home, buildId: "a".repeat(64), role: "controller" as const };
}

test("an exclusive listener identifies its owner and rejects another controller", async () => {
  const options = await fixture();
  const lease = await acquireControlLease(options);
  try {
    await lease.publishIdentity();
    expect(lease.port).toBeGreaterThan(0);
    expect(() => lease.assertOwned()).not.toThrow();
    expect(await identifyController({ port: lease.port })).toEqual({
      type: "identity",
      product: "malleaf",
      pid: process.pid,
      startedAt: lease.identity.startedAt,
      buildId: options.buildId,
      role: "controller",
      homeId: lease.identity.homeId,
    });
    const before = await readFile(path.join(options.home, "runner/controller.json"), "utf8");
    await expect(acquireControlLease({ ...options, port: lease.port })).rejects.toMatchObject({
      code: "lease_held",
    });
    expect(await readFile(path.join(options.home, "runner/controller.json"), "utf8")).toBe(before);
  } finally {
    await lease.release({ seal: async () => {} });
  }
  expect(() => lease.assertOwned()).toThrowError(/lease/);
});

test("release waits for sealed writes before making the port available", async () => {
  const options = await fixture();
  const lease = await acquireControlLease(options);
  let finishSeal = () => {};
  const sealed = new Promise<void>((resolve) => {
    finishSeal = resolve;
  });
  const released = lease.release({ seal: () => sealed });
  try {
    await expect(acquireControlLease({ ...options, port: lease.port })).rejects.toMatchObject({
      code: "lease_held",
    });
  } finally {
    finishSeal();
    await released;
  }
  const replacement = await acquireControlLease({ ...options, port: lease.port });
  await replacement.release({ seal: async () => {} });
});

test("failed sealing retains ownership and an identified port can be rebound after release", async () => {
  const options = await fixture();
  const lease = await acquireControlLease(options);
  try {
    await expect(
      lease.release({
        seal: async () => {
          throw new Error("Cannot seal writer");
        },
      }),
    ).rejects.toThrow("Cannot seal writer");
    expect(() => lease.assertOwned()).not.toThrow();
    expect((await identifyController({ port: lease.port }))?.pid).toBe(process.pid);
    await expect(acquireControlLease({ ...options, port: 0 })).rejects.toThrow();
  } finally {
    await lease.release({ seal: async () => {} });
  }
  const replacement = await acquireControlLease(options);
  await replacement.release({ seal: async () => {} });
});

test("an occupied foreign port is diagnosed without takeover", async () => {
  const options = await fixture();
  const foreign = net.createServer((socket) => {
    socket.resume();
    socket.end("not Malleaf\n");
  });
  await new Promise<void>((resolve) => foreign.listen(0, "127.0.0.1", resolve));
  const address = foreign.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  try {
    await expect(acquireControlLease({ ...options, port: address.port })).rejects.toMatchObject({
      code: "port_occupied",
    });
    expect(foreign.listening).toBe(true);
  } finally {
    await new Promise<void>((resolve) => foreign.close(() => resolve()));
  }
});

test("identity timeout cannot authorize reclaiming a quiet listener", async () => {
  const sockets: net.Socket[] = [];
  const foreign = net.createServer((socket) => {
    sockets.push(socket);
  });
  await new Promise<void>((resolve) => foreign.listen(0, "127.0.0.1", resolve));
  const address = foreign.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  try {
    expect(await identifyController({ port: address.port, timeoutMs: 20 })).toBeNull();
    expect(foreign.listening).toBe(true);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => foreign.close(() => resolve()));
  }
});

test("kernel ownership excludes another process and is released after owner death", async () => {
  const options = await fixture();
  const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const entry = new URL("./lease.ts", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--conditions=source",
      "--import",
      loader,
      "--input-type=module",
      "-e",
      `
    const { acquireControlLease } = await import(process.argv[1]);
    const lease = await acquireControlLease({ home: process.argv[3], port: Number(process.argv[2]), buildId: "a".repeat(64), role: "controller" });
    process.send({ port: lease.port, pid: process.pid });
    process.on("disconnect", () => process.exit(1));
  `,
      entry,
      String(options.port),
      options.home,
    ],
    {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.startsWith("PASEO_") && !key.startsWith("MALLEAF_"),
          ),
        ),
        HOME: options.home,
        USERPROFILE: options.home,
      },
    },
  );
  const exited = once(child, "exit");
  let stderr = "";
  if (!child.stderr) throw new Error("Missing child diagnostics stream");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const ready = once(child, "message", { signal: AbortSignal.timeout(5000) });
  try {
    const [message] = await ready;
    const published = z.object({ port: z.number(), pid: z.number() }).parse(message);
    expect((await identifyController({ port: published.port }))?.pid).toBe(published.pid);
    await expect(acquireControlLease({ ...options, port: published.port })).rejects.toMatchObject({
      code: "lease_held",
    });
    child.kill("SIGKILL");
    await exited;
    const replacement = await acquireControlLease({ ...options, port: published.port });
    await replacement.release({ seal: async () => {} });
    expect(stderr).toBe("");
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
});

test("advisory identity is replaced only after bind and cleaned before relinquishing ownership", async () => {
  const options = await fixture();
  const lease = await acquireControlLease(options);
  await lease.publishIdentity();
  const filename = path.join(options.home, "runner/controller.json");
  const firstIdentity = JSON.parse(await readFile(filename, "utf8"));
  expect(firstIdentity).toMatchObject({ token: lease.token, port: lease.port, pid: process.pid });
  // A foreign advisory file is never a reason to kill a process or steal a port.
  await writeFile(filename, JSON.stringify({ token: "foreign" }));
  await lease.release({ seal: async () => {} });
  expect(JSON.parse(await readFile(filename, "utf8"))).toEqual({ token: "foreign" });
  const next = await acquireControlLease({ ...options, port: lease.port });
  try {
    await next.publishIdentity();
    expect(JSON.parse(await readFile(filename, "utf8"))).toMatchObject({ token: next.token });
  } finally {
    await next.release({ seal: async () => {} });
  }
  await expect(readFile(filename)).rejects.toMatchObject({ code: "ENOENT" });
});
