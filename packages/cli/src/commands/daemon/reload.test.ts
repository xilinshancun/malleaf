import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import type { CommandOptions } from "../../output/index.js";
import { runStopCommand } from "./stop.js";
import { runRestartCommand } from "./restart.js";
import { runDaemonReloadCommand } from "./reload.js";
import { launchLocalDaemon } from "./local-daemon.js";
import { describe, expect, test } from "vitest";
import { render } from "../../output/render.js";
import { daemonReloadSchema, type DaemonReloadResult } from "./reload.js";

const restartCommand = 'malleaf daemon restart --home "/selected home"';

function result(data: DaemonReloadResult) {
  return { type: "single" as const, data, schema: daemonReloadSchema };
}

describe("daemon reload output", () => {
  test("human output reports restart and override warnings", () => {
    expect(
      render(
        result({
          restartCommand,
          appliedPaths: ["daemon.browserTools.enabled"],
          restartRequiredPaths: ["daemon.listen"],
          overrideControlledPaths: ["app.baseUrl"],
        }),
      ),
    ).toBe(
      [
        "Configuration reloaded.",
        "",
        "Warning: These changes require a daemon restart:",
        "  daemon.listen",
        "",
        `Run: ${restartCommand}`,
        "",
        "Warning: These settings are controlled by daemon launch overrides:",
        "  app.baseUrl",
      ].join("\n"),
    );
  });

  test("human output omits restart guidance for a live-only reload", () => {
    const output = render(
      result({
        restartCommand,
        appliedPaths: ["daemon.browserTools.enabled"],
        restartRequiredPaths: [],
        overrideControlledPaths: [],
      }),
    );
    expect(output).toBe("Configuration reloaded.");
    expect(output).not.toContain("restart");
  });

  test("structured output preserves the daemon result", () => {
    const data = {
      restartCommand,
      appliedPaths: ["daemon.browserTools.enabled"],
      restartRequiredPaths: ["daemon.listen"],
      overrideControlledPaths: [],
    };
    expect(render(result(data), { format: "json" })).toBe(JSON.stringify(data, null, 2));
    expect(render(result(data), { format: "yaml" })).toContain(
      "appliedPaths:\n  - daemon.browserTools.enabled",
    );
  });
});

test("managed homes reject local launch, stop, restart and reload before any process action", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "malleaf-cli-authority-"));
  try {
    await mkdir(path.join(home, "runtime"));
    await writeFile(
      path.join(home, "runtime/controller-authority.json"),
      JSON.stringify({ schemaVersion: 1, tokenHash: "a".repeat(64) }),
    );
    const options = { daemonTarget: { kind: "instance", home } } as CommandOptions;
    for (const run of [runStopCommand, runRestartCommand, runDaemonReloadCommand])
      await expect(run(options, new Command())).rejects.toThrow("controller_owned");
    await expect(launchLocalDaemon({ home })).rejects.toThrow("controller_owned");
    await writeFile(path.join(home, "runtime/controller-authority.json"), "{");
    await expect(runStopCommand(options, new Command())).rejects.toThrow(
      "Invalid controller authority marker",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
