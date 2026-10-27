import type { OrchestrationSkills, SkillsSnapshot } from "../orchestration-skills/index.js";

export class GlobalHarnessIntegrationDisabledError extends Error {
  constructor(operation: string) {
    super(
      `Malleaf does not manage global Paseo skills (${operation}). Per-session agent tools remain available.`,
    );
    this.name = "GlobalHarnessIntegrationDisabledError";
  }
}

function emptySelection(): SkillsSnapshot {
  return {
    state: "not-installed",
    ops: [],
    available: [],
    installed: [],
    selection: { mode: "custom", skills: [] },
  };
}

async function rejectMutation(operation: string): Promise<never> {
  throw new GlobalHarnessIntegrationDisabledError(operation);
}

// RFC-0001: Even upstream status calls recover transactions and write global homes.
// Malleaf has no global skill ownership, so no operation enters that controller.
export function createMalleafOrchestrationSkills(): OrchestrationSkills {
  return {
    getStatus: async () => emptySelection(),
    autoUpdate: async () => emptySelection(),
    reconcile: () => rejectMutation("reconcile"),
    uninstall: () => rejectMutation("uninstall"),
    saveSelection: () => rejectMutation("save selection"),
    importLegacySelectionIfUnset: async () => ({
      imported: false,
      selection: { mode: "custom", skills: [] },
    }),
  };
}
