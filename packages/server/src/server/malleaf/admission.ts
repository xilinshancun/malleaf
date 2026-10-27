import { AsyncLocalStorage } from "node:async_hooks";

interface Admission {
  manager: object | null;
  agentId: string;
  active: boolean;
}
const context = new AsyncLocalStorage<Admission>();
const draining = new WeakSet<object>();
const pending = new WeakMap<object, number>();

export class AgentManagerDrainingError extends Error {
  constructor() {
    super("Agent manager is draining for a runtime switch; retry after the switch or cancel it");
    this.name = "AgentManagerDrainingError";
  }
}

export function beginMalleafDrain(manager: object): void {
  draining.add(manager);
}
export function endMalleafDrain(manager: object): void {
  draining.delete(manager);
}
export function hasMalleafAdmission(manager: object, agentId?: string): boolean {
  const admission = context.getStore();
  return (
    admission?.active === true &&
    admission.manager === manager &&
    agentId !== undefined &&
    admission.agentId === agentId
  );
}
export function assertMalleafAdmission(manager: object, agentId?: string): void {
  if (draining.has(manager) && !hasMalleafAdmission(manager, agentId))
    throw new AgentManagerDrainingError();
}
export function pendingMalleafAdmissions(manager: object): number {
  return pending.get(manager) ?? 0;
}

// Internal continuations only. The wire cannot mint this process-local scope.
// Count even continuations: permission handling can await before reserving its next turn.
export function runAcceptedMalleafWork<T>(
  manager: object,
  agentId: string,
  work: () => Promise<T>,
): Promise<T> {
  const admission: Admission = { manager, agentId, active: true };
  pending.set(manager, pendingMalleafAdmissions(manager) + 1);
  return context.run(admission, async () => {
    try {
      return await work();
    } finally {
      admission.active = false;
      admission.manager = null;
      const remaining = pendingMalleafAdmissions(manager) - 1;
      if (remaining === 0) pending.delete(manager);
      else pending.set(manager, remaining);
    }
  });
}

export function runNewMalleafWork<T>(
  manager: object,
  agentId: string,
  work: () => Promise<T>,
): Promise<T> {
  // No await between admission and accounting, including before receipt publication.
  if (draining.has(manager)) throw new AgentManagerDrainingError();
  return runAcceptedMalleafWork(manager, agentId, work);
}
