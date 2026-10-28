#!/usr/bin/env node
// Installed as one CommonJS file so a package.json in an ancestor cannot change
// its module mode. Keep every dependency in this entry a Node built-in.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash, randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { parseArgs } = require("node:util");

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const within = (root, filename) => filename.startsWith(`${root}${path.sep}`);
const buildPattern = /^[a-f0-9]{64}$/;

async function physical(directory) {
  if (!(await fs.lstat(directory)).isDirectory())
    throw new Error(`Expected physical directory: ${directory}`);
  return fs.realpath(directory);
}

async function readDocument(filename) {
  if (!(await fs.lstat(filename)).isFile())
    throw new Error(`Expected regular document: ${filename}`);
  const value = JSON.parse(await fs.readFile(filename, "utf8"));
  if (
    !value ||
    !Number.isInteger(value.schemaVersion) ||
    value.schemaVersion < 1 ||
    !Number.isInteger(value.minReaderVersion) ||
    value.minReaderVersion < 1 ||
    value.minReaderVersion > value.schemaVersion ||
    value.minReaderVersion > 1
  )
    throw new Error(`Unsupported document: ${filename}`);
  return value;
}

async function validateHome(values) {
  if (
    !values.home ||
    !values["acceptance-root"] ||
    !process.env.HOME ||
    process.env.MALLEAF_TEST !== "1"
  )
    throw new Error(
      "Stable boot currently requires --home and an explicit isolated --acceptance-root",
    );
  const home = await physical(values.home);
  const root = await physical(values["acceptance-root"]);
  await protectAccountState(root, home);
  const temporary = await fs.realpath(os.tmpdir());
  const fakeHome = await fs.realpath(process.env.HOME ?? "");
  if (!within(temporary, root) || !within(root, home) || !within(root, fakeHome))
    throw new Error("Stable boot is restricted to a disposable home and isolated OS environment");
  await physical(path.join(home, "runner"));
  return { home, root };
}

async function canonicalBoundary(filename) {
  try {
    return await fs.realpath(filename);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = path.dirname(filename);
    if (parent === filename) return filename;
    return path.join(await canonicalBoundary(parent), path.basename(filename));
  }
}

async function protectAccountState(root, home) {
  const normalize = (value) =>
    process.platform === "win32" || process.platform === "darwin" ? value.toLowerCase() : value;
  const native = await fs.realpath(os.userInfo().homedir);
  const contains = (parent, child) => parent === child || within(parent, child);
  const roots = [root, home].map(normalize);
  if (contains(roots[0], normalize(native)))
    throw new Error("Acceptance root cannot contain the account home");
  for (const relative of [
    ".malleaf",
    ".malleaf-dev",
    ".paseo",
    "Library/Application Support/Malleaf",
    "Library/Application Support/Paseo",
    "Library/Logs/Malleaf",
    "Library/Logs/Paseo",
    ".config/Malleaf",
    ".config/Paseo",
    "AppData/Roaming/Malleaf",
    "AppData/Roaming/Paseo",
  ]) {
    const protectedPath = normalize(await canonicalBoundary(path.join(native, relative)));
    if (roots.some((value) => contains(value, protectedPath) || contains(protectedPath, value)))
      throw new Error("Acceptance directories overlap installed product state");
  }
}

async function controllerEntry(home, buildId) {
  if (!buildPattern.test(buildId ?? "")) throw new Error("Invalid controller build identity");
  const versions = await physical(path.join(home, "versions"));
  const slot = await physical(path.join(versions, buildId));
  const manifestFile = path.join(slot, "malleaf.json");
  if (!(await fs.lstat(manifestFile)).isFile())
    throw new Error("Slot manifest must be a regular file");
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  const entry = manifest.entries?.controller;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.buildId !== buildId ||
    typeof entry !== "string" ||
    path.isAbsolute(entry) ||
    entry.split(/[\\/]/).some((part) => part === ".." || part === ".")
  )
    throw new Error("Invalid controller entry manifest");
  const filename = path.join(slot, entry);
  if (!(await fs.lstat(filename)).isFile() || !within(slot, await fs.realpath(filename)))
    throw new Error("Controller entry escapes its slot");
  const record = manifest.files?.find((file) => file.kind === "file" && file.path === entry);
  if (!record || digest(await fs.readFile(filename)) !== record.sha256)
    throw new Error("Controller entry hash does not match its manifest");
  // A missing dependency must not be borrowed from an ancestor installation.
  for (let parent = path.dirname(slot); ; parent = path.dirname(parent)) {
    try {
      await fs.lstat(path.join(parent, "node_modules"));
      throw new Error(`Slot ancestor has node_modules: ${parent}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (path.dirname(parent) === parent) break;
  }
  return filename;
}

function runController({ entry, buildId, home, root, port, stopped }) {
  return new Promise((resolve) => {
    const attempt = randomUUID();
    let loaded = false;
    let rejected = null;
    let loadTimedOut = false;
    let processError = null;
    let finished = false;
    const child = spawn(
      process.execPath,
      [entry, "--home", home, "--acceptance-root", root, "--control-port", String(port)],
      {
        stdio: ["inherit", "inherit", "inherit", "ipc"],
        env: {
          ...process.env,
          MALLEAF_HOME: home,
          MALLEAF_HOST_NODE_OPTIONS: process.env.NODE_OPTIONS ?? "",
          MALLEAF_HOST_NODE_PATH: process.env.NODE_PATH ?? "",
          NODE_OPTIONS: "--no-global-search-paths",
          NODE_PATH: "",
        },
      },
    );
    const loadTimer = setTimeout(() => {
      if (loaded) return;
      loadTimedOut = true;
      // Our own child has not received authority to acquire a lease. Fallback
      // still waits for its observed exit, and late loaded messages get no ACK.
      try {
        child.kill("SIGKILL");
      } catch (error) {
        processError = String(error);
      }
    }, 10_000);
    const requestStop = () => {
      stopped.value = true;
      if (child.connected) child.send({ type: "malleaf.controller.stop" }, () => {});
    };
    process.once("SIGTERM", requestStop);
    process.once("SIGINT", requestStop);
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(loadTimer);
      process.off("SIGTERM", requestStop);
      process.off("SIGINT", requestStop);
      let code = result.code;
      if (loadTimedOut) code = 124;
      if (rejected) code = 78;
      // Timer cancellation above is not settlement; finished guards this sole resolver.
      // oxlint-disable-next-line promise/no-multiple-resolved
      resolve({
        ...result,
        code,
        loadTimedOut,
        processError,
        rejected,
        loaded,
        interrupted: stopped.value,
      });
    };
    child.on("message", (message) => {
      if (message?.type !== "malleaf.controller.loaded" || loaded || loadTimedOut) return;
      // Disable fallback BEFORE authorizing any lease or recovery side effect.
      loaded = true;
      clearTimeout(loadTimer);
      if (message.buildId !== buildId || message.version !== 1) {
        rejected = "Controller load handshake identity or version mismatch";
        child.send({ type: "malleaf.controller.reject", reason: rejected }, () => {});
        return;
      }
      if (stopped.value) {
        requestStop();
        return;
      }
      child.send({ type: "malleaf.controller.proceed", attempt }, () => {});
    });
    child.on("error", (error) => {
      processError = String(error);
      // A spawn failure has no process. Later errors cannot establish exit and
      // therefore cannot authorize fallback while that child may still be alive.
      if (child.pid === undefined) finish({ code: 70, signal: null });
    });
    child.once("exit", (code, signal) => finish({ code: code ?? 70, signal }));
  });
}

async function saveDiagnostic(home, attempts) {
  const directory = path.join(home, "runner/stable");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await physical(directory);
  const filename = path.join(directory, "last-boot.json");
  const temporary = `${filename}.${randomUUID()}.partial`;
  try {
    await fs.writeFile(temporary, JSON.stringify({ schemaVersion: 1, attempts }, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: { home: { type: "string" }, "acceptance-root": { type: "string" } },
  });
  const { home, root } = await validateHome(values);
  const config = await readDocument(path.join(home, "runner/runner.json"));
  const pointer = await readDocument(path.join(home, "runner/current.json"));
  if (!Number.isInteger(config.controlPort) || config.controlPort < 1 || config.controlPort > 65535)
    throw new Error("Invalid controller port");
  if (
    !buildPattern.test(pointer.current?.buildId ?? "") ||
    (pointer.previous != null && !buildPattern.test(pointer.previous.buildId ?? ""))
  )
    throw new Error("Invalid selected controller identity");
  const builds = [pointer.current.buildId, pointer.previous?.buildId].filter(
    (id, index, all) => id && all.indexOf(id) === index,
  );
  const attempts = [];
  const stopped = { value: false };
  for (const buildId of builds) {
    let result;
    try {
      const entry = await controllerEntry(home, buildId);
      result = await runController({
        entry,
        buildId,
        home,
        root,
        port: config.controlPort,
        stopped,
      });
    } catch (error) {
      result = { code: 65, loaded: false, error: String(error) };
    }
    attempts.push({ buildId, at: new Date().toISOString(), ...result });
    await saveDiagnostic(home, attempts).catch((error) =>
      process.stderr.write(`Cannot save boot diagnostics: ${error}\n`),
    );
    // Loaded code owns all runtime diagnoses. Unknown errors after this boundary,
    // signal termination and explicit user interruption never try another slot.
    if (
      result.code === 0 ||
      result.loaded ||
      (result.signal && !result.loadTimedOut) ||
      result.interrupted
    )
      return result.code;
  }
  return attempts.at(-1).code;
}

main()
  .then((code) => {
    process.exitCode = code;
    return code;
  })
  .catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 65;
  });
