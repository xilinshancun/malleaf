import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, realpath } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { isolatedDaemonEnvironment } from "./isolated-environment";

const execFileAsync = promisify(execFile);

export interface PackagedWebDaemon {
  home: string;
  origin: string;
  port: number;
  serverId: string;
  pairingOfferUrl(): Promise<string>;
  close(): Promise<void>;
}

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a daemon port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForWebUi(origin: string, home: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(1_000) });
      const body = await response.text();
      if (response.ok && body.includes("<html")) return;
      lastError = new Error(`Daemon web UI returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const log = await readFile(path.join(home, "daemon.log"), "utf8").catch(() => "");
  throw new Error(
    `Daemon web UI did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}\n${log.split("\n").slice(-80).join("\n")}`,
  );
}

export async function startPackagedWebDaemon(input: {
  relayEndpoint: string;
}): Promise<PackagedWebDaemon> {
  const port = await availablePort();
  const home = await mkdtemp(path.join(tmpdir(), "paseo-relay-deployment-e2e-"));
  const osHome = await mkdtemp(path.join(tmpdir(), "malleaf-packaged-web-os-home-"));
  const serverId = `relay-deployment-${Date.now().toString(36)}`;
  const repo = await realpath(path.resolve(__dirname, "../../../../.."));
  const paseo = await realpath(path.join(repo, "packages/cli/bin/paseo"));
  if (!paseo.startsWith(repo + path.sep))
    throw new Error("CLI fixture must use the repository entry");
  const env: NodeJS.ProcessEnv = {
    ...isolatedDaemonEnvironment(osHome, home, {}, process.env.E2E_USE_HOST_HARNESS === "1"),
    CI: "true",
    NODE_ENV: "development",
    MALLEAF_NODE_ENV: "development",
    MALLEAF_SERVER_ID: serverId,
  };

  try {
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify({
        app: { baseUrl: "https://app.example.test" },
        daemon: {
          listen: `127.0.0.1:${port}`,
          relay: {
            enabled: true,
            endpoint: input.relayEndpoint,
            publicEndpoint: input.relayEndpoint,
            useTls: false,
            publicUseTls: false,
          },
        },
        features: {
          webUi: { enabled: true },
          dictation: { enabled: false },
          voiceMode: { enabled: false },
        },
      }),
    );
    await execFileAsync(process.execPath, [paseo, "daemon", "start", "--home", home], { env });
    const origin = `http://127.0.0.1:${port}`;
    await waitForWebUi(origin, home);

    return {
      home,
      origin,
      port,
      serverId,
      pairingOfferUrl: async () => {
        const { stdout } = await execFileAsync(
          process.execPath,
          [paseo, "daemon", "pair", "--home", home, "--relay", "--json"],
          { env },
        );
        const result = JSON.parse(stdout) as { url?: unknown };
        if (typeof result.url !== "string") {
          throw new Error(`Pairing command returned no URL: ${stdout}`);
        }
        return result.url;
      },
      close: async () => {
        await execFileAsync(process.execPath, [paseo, "daemon", "stop", "--home", home], {
          env,
        }).catch(() => undefined);
        await rm(home, { recursive: true, force: true });
        await rm(osHome, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await execFileAsync(process.execPath, [paseo, "daemon", "stop", "--home", home], { env }).catch(
      () => undefined,
    );
    await rm(home, { recursive: true, force: true });
    await rm(osHome, { recursive: true, force: true });
    throw error;
  }
}
