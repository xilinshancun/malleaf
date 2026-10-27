import { initializeMalleafEnvironment } from "@getpaseo/server/malleaf-runtime";

initializeMalleafEnvironment();
const { runCli } = await import("./run.js");

const exitCode = await runCli(process.argv.slice(2), {
  nodeArgv: [process.argv[0] ?? "node", process.argv[1] ?? "malleaf"],
});
process.exitCode = exitCode;
