import { createMalleafEnvironment } from "../../packages/server/src/server/malleaf/environment.js";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: process.argv.slice(3),
  options: {
    listen: { type: "string" },
    json: { type: "boolean" },
    prepare: { type: "boolean" },
  },
});
const env = createMalleafEnvironment(process.env, {
  developmentRoot: process.argv[2],
  developmentListen: values.listen,
});
if (values.prepare) {
  const home = env.MALLEAF_DAEMON_HOME!;
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, "config.json");
  let config: {
    version?: number;
    daemon?: {
      listen?: string;
      cors?: { allowedOrigins: string[] };
      relay?: Record<string, unknown>;
    };
  } = {};
  try {
    config = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  config.version ??= 1;
  config.daemon ??= {};
  config.daemon.listen = env.PASEO_LISTEN;
  config.daemon.cors = { allowedOrigins: ["*"] };
  config.daemon.relay = { ...config.daemon.relay, enabled: false };
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
  await rename(temporary, file);
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
if (values.json) {
  process.stdout.write(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(env).filter(([key]) => /^(MALLEAF|PASEO)_[A-Z0-9_]+$/.test(key)),
      ),
    ),
  );
  process.exit(0);
}
for (const key of Object.keys(process.env)) {
  if (/^(MALLEAF|PASEO)_[A-Z0-9_]+$/.test(key)) process.stdout.write(`unset ${key}\n`);
}
for (const [key, value] of Object.entries(env)) {
  if (/^(MALLEAF|PASEO)_[A-Z0-9_]+$/.test(key) && value !== undefined) {
    process.stdout.write(`export ${key}=${quote(value)}\n`);
  }
}
