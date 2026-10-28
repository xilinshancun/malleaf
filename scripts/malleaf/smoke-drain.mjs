import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const counters = [
  "pendingRegistrations",
  "pendingAdmissions",
  "pendingDeliveries",
  "pendingScheduleRuns",
];

async function waitForStatus(quiesce, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let status;
  do {
    status = await quiesce({ action: "status", deadlineMs: 1000 });
    if (predicate(status)) return status;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail(`Drain condition timed out: ${JSON.stringify(status)}`);
}

// Uses the actual copied daemon's mock provider, never an installed harness.
export async function exerciseMockDrain(
  client,
  cwd,
  quiesce = (request) => client.quiesceDaemon(request),
) {
  const agent = await client.createAgent({ provider: "mock", model: "ten-second-stream", cwd });
  const idle = await client.createAgent({ provider: "mock", model: "ten-second-stream", cwd });
  const empty = (status) =>
    status.running.length === 0 &&
    status.pendingPermissions.length === 0 &&
    counters.every((key) => status[key] === 0);
  await client.sendMessage(agent.id, "Complete this accepted mock turn during the drain.");
  await waitForStatus(quiesce, (status) => status.running.includes(agent.id));
  const drainId = randomUUID();
  const active = await quiesce({ action: "begin", drainId, deadlineMs: 30_000 });
  const activeAt = new Date().toISOString();
  assert.equal(active.state, "draining");
  assert.ok(active.running.includes(agent.id));
  await assert.rejects(client.sendMessage(idle.id, "This new turn must be rejected."), /drain/i);
  await assert.rejects(client.createAgent({ provider: "mock", cwd }), /drain/i);
  const finished = await client.waitForFinish(agent.id, 20_000);
  assert.equal(finished.status, "idle");
  assert.equal(finished.error, null);
  const drained = await waitForStatus(quiesce, empty);
  const drainedAt = new Date().toISOString();
  assert.equal(drained.state, "draining");
  assert.equal(drained.drainId, drainId);
  await quiesce({ action: "end", drainId, deadlineMs: 1000 });

  await client.sendMessage(agent.id, "This accepted turn will be cancelled during drain.");
  await waitForStatus(quiesce, (status) => status.running.includes(agent.id));
  const cancelDrainId = randomUUID();
  const cancelActive = await quiesce({
    action: "begin",
    drainId: cancelDrainId,
    deadlineMs: 30_000,
  });
  assert.ok(cancelActive.running.includes(agent.id));
  const cancelActiveAt = new Date().toISOString();
  await client.cancelAgent(agent.id);
  const cancelled = await waitForStatus(quiesce, empty);
  const cancelledAt = new Date().toISOString();
  assert.equal(cancelled.state, "draining");
  await quiesce({ action: "end", drainId: cancelDrainId, deadlineMs: 1000 });
  assert.equal((await quiesce({ action: "status", deadlineMs: 1000 })).state, "accepting");
  return {
    agentId: agent.id,
    active,
    activeAt,
    finishStatus: finished.status,
    drained,
    drainedAt,
    cancelActive,
    cancelActiveAt,
    cancelled,
    cancelledAt,
    newTurnRejected: true,
    newAgentRejected: true,
  };
}
