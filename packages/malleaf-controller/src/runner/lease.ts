import { randomBytes } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import net, { type Socket } from "node:net";
import path from "node:path";
import { z } from "zod";
import { assertStoragePath } from "../isolation.js";
import { containedRealPath, exists, readJson, StorageError, writeJsonAtomic } from "../storage.js";

const identitySchema = z.object({
  type: z.literal("identity"),
  product: z.literal("malleaf"),
  pid: z.number().int().positive(),
  startedAt: z.string().datetime(),
  buildId: z.string().regex(/^[a-f0-9]{64}$/),
  role: z.enum(["init", "controller", "candidate"]),
});
export type ControllerIdentity = z.infer<typeof identitySchema>;

interface LeaseOptions {
  port: number;
  buildId: string;
  role: ControllerIdentity["role"];
}

interface IdentifyOptions {
  port: number;
  timeoutMs?: number;
}

// Identification is diagnostic only. It neither authorizes commands nor proves
// that a nonresponding listener is dead or safe to replace.
export async function identifyController({
  port,
  timeoutMs = 2000,
}: IdentifyOptions): Promise<ControllerIdentity | null> {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  const deadline = setTimeout(() => socket.destroy(), timeoutMs);
  socket.setEncoding("utf8");
  socket.once("connect", () => socket.write('{"type":"identify"}\n'));
  let received = "";
  try {
    for await (const chunk of socket) {
      received += chunk;
      if (received.length > 8192) return null;
      const end = received.indexOf("\n");
      if (end < 0) continue;
      const parsed = identitySchema.safeParse(JSON.parse(received.slice(0, end)));
      return parsed.success ? parsed.data : null;
    }
    return null;
  } catch {
    // Diagnostic failure never grants ownership of an occupied port.
    return null;
  } finally {
    clearTimeout(deadline);
    socket.destroy();
  }
}

export async function acquireControlLease(options: LeaseOptions) {
  z.number().int().min(1).max(65535).parse(options.port);
  const identity = identitySchema.parse({
    type: "identity",
    product: "malleaf",
    pid: process.pid,
    startedAt: new Date().toISOString(),
    buildId: options.buildId,
    role: options.role,
  });
  const token = randomBytes(32).toString("hex");
  const sockets = new Set<Socket>();
  let closed = false;
  let failed = false;
  let identityFile: string | undefined;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setTimeout(2000, () => socket.destroy());
    socket.setEncoding("utf8");
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk;
      if (received.length > 8192) return socket.destroy();
      const end = received.indexOf("\n");
      if (end < 0) return;
      try {
        const request = z
          .object({ type: z.literal("identify") })
          .safeParse(JSON.parse(received.slice(0, end)));
        if (request.success) socket.write(`${JSON.stringify(identity)}\n`);
        else socket.destroy();
      } catch {
        // Invalid frames only close this diagnostic connection.
        socket.destroy();
      }
    });
  });
  server.maxConnections = 32;
  server.once("close", () => {
    closed = true;
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: options.port, exclusive: true }, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) throw error;
    const owner = await identifyController({ port: options.port });
    if (owner)
      throw new StorageError(
        "lease_held",
        `Control port ${options.port} is held by Malleaf pid ${owner.pid}`,
      );
    throw new StorageError(
      "port_occupied",
      `Control port ${options.port} is occupied by an unidentified process`,
    );
  }
  server.on("error", () => {
    failed = true;
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new StorageError("lease_lost", "Control lease has no TCP address");
  const port = address.port;

  function assertOwned(): void {
    const bound = server.address();
    if (
      closed ||
      failed ||
      !server.listening ||
      !bound ||
      typeof bound === "string" ||
      bound.port !== port
    )
      throw new StorageError("lease_lost", "Control listener lease was lost");
  }

  async function publishIdentity(home: string): Promise<void> {
    assertOwned();
    if (identityFile)
      throw new StorageError("state_conflict", "Lease identity was already published");
    assertStoragePath(home);
    const runner = path.join(home, "runner");
    assertStoragePath(runner);
    await mkdir(runner, { recursive: true });
    await containedRealPath(await realpath(home), runner);
    if (!(await lstat(runner)).isDirectory())
      throw new StorageError("unsafe_path", "Runner must be a physical directory");
    const name = identity.role === "candidate" ? "controller-candidate.json" : "controller.json";
    const filename = path.join(runner, name);
    if (await exists(filename)) await rename(filename, `${filename}.stale`);
    assertOwned();
    await writeJsonAtomic({
      filename,
      value: { schemaVersion: 1, ...identity, token, port },
      beforeCommit: assertOwned,
    });
    identityFile = filename;
  }

  async function release({ seal }: { seal: () => Promise<void> }): Promise<void> {
    // The pointer queue must drain while the kernel still excludes other writers.
    await seal();
    if (closed) return;
    try {
      if (identityFile && (await exists(identityFile))) {
        const stored = z.object({ token: z.string() }).parse(await readJson(identityFile));
        if (stored.token === token) await rm(identityFile);
      }
    } finally {
      // Remove our advisory identity before close, so cleanup cannot race the
      // next owner's publication after it acquires this port.
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) return reject(error);
          resolve();
        }),
      );
    }
  }

  return { port, identity, token, assertOwned, publishIdentity, release };
}
