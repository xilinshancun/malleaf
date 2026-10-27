import { build } from "esbuild";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test.each([
  "./slot/materialize.ts",
  "./data/epoch.ts",
  "./runner/pointer.ts",
  "./runner/lease.ts",
  "./runner/initialize.ts",
])("%s stays independent of the daemon implementation", async (entry) => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    write: false,
    metafile: true,
    treeShaking: false,
    platform: "node",
    format: "esm",
    conditions: ["source"],
    logLevel: "silent",
    plugins: [
      {
        name: "public-controller-api",
        setup(builder) {
          builder.onResolve({ filter: /^@getpaseo\/server(?:\/|$)/ }, ({ path }) => {
            const allowed = [
              "@getpaseo/server/malleaf-runtime",
              "@getpaseo/server/daemon-control",
              "@getpaseo/server/configuration",
              "@getpaseo/server/process",
            ];
            if (!allowed.includes(path))
              throw new Error(`Controller depends on a private daemon entry: ${path}`);
          });
          builder.onResolve({ filter: /^[^./]/ }, ({ path }) => {
            if (!isAbsolute(path) && !path.startsWith("@getpaseo/"))
              return { path, external: true };
          });
        },
      },
    ],
  });
  const files = Object.keys(result.metafile.inputs);
  expect(files.length).toBeGreaterThan(1);
  expect(
    files.filter((file) => /\/(?:bootstrap|agent-manager|session|messages)\.[jt]s$/.test(file)),
  ).toEqual([]);
});
