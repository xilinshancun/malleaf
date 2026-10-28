import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type {
  AgentPromptInput,
  AgentPermissionResult,
  AgentRunOptions,
  AgentPermissionResponse,
} from "./agent-sdk-types.js";
import type { AgentStreamEvent } from "../messages.js";
import { respondToAgentPermission } from "./permission-response.js";
import {
  assertMalleafAdmission,
  beginMalleafDrain,
  pendingMalleafAdmissions,
} from "../malleaf/admission.js";

class FakePermissionAgentManager {
  permissionResult: AgentPermissionResult | void;
  hasRunInFlight = false;
  outOfBandHandled = false;
  permissionResponses: Array<{
    agentId: string;
    requestId: string;
    response: AgentPermissionResponse;
  }> = [];
  streamRuns: Array<{ agentId: string; prompt: AgentPromptInput; options?: AgentRunOptions }> = [];
  replacementRuns: Array<{ agentId: string; prompt: AgentPromptInput; options?: AgentRunOptions }> =
    [];

  async respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void> {
    this.permissionResponses.push({ agentId, requestId, response });
    return this.permissionResult;
  }

  async tryRunOutOfBand(): Promise<boolean> {
    return this.outOfBandHandled;
  }

  getAgent() {
    return undefined;
  }

  async reloadStalePluginSession(): Promise<void> {}

  hasInFlightRun(): boolean {
    return this.hasRunInFlight;
  }

  streamAgent(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): AsyncGenerator<AgentStreamEvent> {
    this.streamRuns.push({ agentId, prompt, options });
    return emptyAgentStream();
  }

  async replaceAgentRun(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<AsyncGenerator<AgentStreamEvent>> {
    this.replacementRuns.push({ agentId, prompt, options });
    return emptyAgentStream();
  }
}

async function* emptyAgentStream(): AsyncGenerator<AgentStreamEvent> {}

describe("respondToAgentPermission", () => {
  const logger = createTestLogger();

  test("Malleaf drain counts a permission continuation across asynchronous provider admission", async () => {
    let allowReload!: () => void;
    const reload = new Promise<void>((resolve) => {
      allowReload = resolve;
    });
    let reloadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      reloadStarted = resolve;
    });
    class DelayedPermissionManager extends FakePermissionAgentManager {
      override async reloadStalePluginSession() {
        reloadStarted();
        await reload;
      }
      override streamAgent(agentId: string, prompt: AgentPromptInput, options?: AgentRunOptions) {
        assertMalleafAdmission(this, agentId);
        return super.streamAgent(agentId, prompt, options);
      }
    }
    const agentManager = new DelayedPermissionManager();
    agentManager.permissionResult = { followUpPrompt: "approved continuation" };
    beginMalleafDrain(agentManager);
    const response = respondToAgentPermission({
      agentManager,
      agentId: "agent-1",
      requestId: "permission-1",
      response: { behavior: "allow" },
      logger,
    });
    await started;
    expect(pendingMalleafAdmissions(agentManager)).toBe(1);
    allowReload();
    await response;
    expect(pendingMalleafAdmissions(agentManager)).toBe(0);
    expect(agentManager.streamRuns).toEqual([
      { agentId: "agent-1", prompt: "approved continuation", options: undefined },
    ]);
    expect(() => agentManager.streamAgent("agent-1", "new work")).toThrow("draining");
  });

  test("starts a follow-up run returned by the provider permission response", async () => {
    const agentManager = new FakePermissionAgentManager();
    agentManager.permissionResult = { followUpPrompt: "implement the approved plan" };

    await respondToAgentPermission({
      agentManager,
      agentId: "agent-1",
      requestId: "permission-1",
      response: { behavior: "allow" },
      logger,
    });

    expect(agentManager.permissionResponses).toEqual([
      {
        agentId: "agent-1",
        requestId: "permission-1",
        response: { behavior: "allow" },
      },
    ]);
    expect(agentManager.streamRuns).toEqual([
      {
        agentId: "agent-1",
        prompt: "implement the approved plan",
      },
    ]);
    expect(agentManager.replacementRuns).toEqual([]);
  });

  test("does not start a run when the permission response has no follow-up prompt", async () => {
    const agentManager = new FakePermissionAgentManager();

    await respondToAgentPermission({
      agentManager,
      agentId: "agent-1",
      requestId: "permission-1",
      response: { behavior: "deny", message: "not now" },
      logger,
    });

    expect(agentManager.permissionResponses).toEqual([
      {
        agentId: "agent-1",
        requestId: "permission-1",
        response: { behavior: "deny", message: "not now" },
      },
    ]);
    expect(agentManager.streamRuns).toEqual([]);
    expect(agentManager.replacementRuns).toEqual([]);
  });

  test("replaces an in-flight run for follow-up prompts", async () => {
    const agentManager = new FakePermissionAgentManager();
    agentManager.hasRunInFlight = true;
    agentManager.permissionResult = { followUpPrompt: "continue after approval" };

    await respondToAgentPermission({
      agentManager,
      agentId: "agent-1",
      requestId: "permission-1",
      response: { behavior: "allow" },
      logger,
    });

    expect(agentManager.streamRuns).toEqual([]);
    expect(agentManager.replacementRuns).toEqual([
      {
        agentId: "agent-1",
        prompt: "continue after approval",
      },
    ]);
  });
});
