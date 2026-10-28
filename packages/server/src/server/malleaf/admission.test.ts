import { expect, test, onTestFinished } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  hasMalleafAdmission,
  pendingMalleafAdmissions,
  runAcceptedMalleafWork,
  runNewMalleafWork,
  beginMalleafDrain,
  assertMalleafAdmission,
} from "./admission.js";
import { MessageReceipts } from "../message-receipts/index.js";
import { createAgentMessageDelivery } from "../agent/agent-messages/delivery.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("accepted work is counted synchronously and cannot authorize another manager or a later callback", async () => {
  const manager = {};
  const noWork = async () => {};
  const otherManager = {};
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let releaseLate!: () => void;
  const late = new Promise<void>((resolve) => {
    releaseLate = resolve;
  });
  let inherited!: Promise<boolean>;
  const running = runAcceptedMalleafWork(manager, "parent", async () => {
    expect(hasMalleafAdmission(manager, "parent")).toBe(true);
    expect(hasMalleafAdmission(otherManager, "parent")).toBe(false);
    beginMalleafDrain(manager);
    expect(() => assertMalleafAdmission(manager, "another-agent")).toThrow("draining");
    expect(() => assertMalleafAdmission(manager)).toThrow("draining");
    expect(() => runNewMalleafWork(manager, "parent", noWork)).toThrow("draining");
    inherited = late.then(() => hasMalleafAdmission(manager, "parent"));
    await held;
  });
  expect(pendingMalleafAdmissions(manager)).toBe(1);
  expect(hasMalleafAdmission(manager, "parent")).toBe(false);
  finish();
  await running;
  expect(pendingMalleafAdmissions(manager)).toBe(0);
  releaseLate();
  await expect(inherited).resolves.toBe(false);
  await expect(
    runAcceptedMalleafWork(manager, "parent", async () => {
      throw new Error("failed");
    }),
  ).rejects.toThrow("failed");
  expect(pendingMalleafAdmissions(manager)).toBe(0);
});

test("draining across receipt publication preserves an accepted message through queued and in-flight delivery", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "malleaf-admission-receipts-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const receipts = new MessageReceipts(directory);
  const manager = {};
  const prepared = deferred();
  const prepareAllowed = deferred();
  const enqueued = deferred();
  const dispatchStarted = deferred();
  const providerAccepted = deferred();
  const timers = new Set<() => void>();
  const delivery = createAgentMessageDelivery({
    assertAdmitting: (recipientId) => assertMalleafAdmission(manager, recipientId),
    schedule: (_ms, callback) => {
      timers.add(callback);
      return () => {
        timers.delete(callback);
      };
    },
    dispatch: () =>
      runAcceptedMalleafWork(manager, "parent", async () => {
        assertMalleafAdmission(manager, "parent");
        dispatchStarted.resolve();
        await providerAccepted.promise;
        return "turn_started";
      }),
    onError: (error) => {
      throw error;
    },
  });
  const message = {
    recipientId: "parent",
    messageId: "accepted",
    prompt: "report",
    source: { kind: "agent-message" as const, agentId: "child" },
  };
  const sent = runNewMalleafWork(manager, "parent", () =>
    receipts.send({
      agentId: "parent",
      messageId: "accepted",
      request: { text: "report" },
      prepare: async () => {
        prepared.resolve();
        await prepareAllowed.promise;
      },
      send: async () => {
        const receipt = delivery.enqueue(message);
        enqueued.resolve();
        await receipt.dispatched;
      },
    }),
  );
  await prepared.promise;
  beginMalleafDrain(manager);
  expect(pendingMalleafAdmissions(manager)).toBe(1);
  expect(delivery.pendingCount()).toBe(0);
  expect(() => delivery.enqueue({ ...message, messageId: "new-agent-message" })).toThrow(
    "draining",
  );
  expect(() =>
    runNewMalleafWork(manager, "parent", () =>
      receipts.send({
        agentId: "parent",
        messageId: "new-human-message",
        request: {},
        send: async () => {},
      }),
    ),
  ).toThrow("draining");
  expect(await readdir(directory)).toEqual([]);
  prepareAllowed.resolve();
  await enqueued.promise;
  expect(delivery.pendingCount()).toBe(1);
  for (const callback of timers) callback();
  await dispatchStarted.promise;
  expect(pendingMalleafAdmissions(manager)).toBe(2);
  expect(delivery.pendingCount()).toBe(1);
  providerAccepted.resolve();
  await sent;
  await delivery.close();
  expect(pendingMalleafAdmissions(manager)).toBe(0);
  expect(delivery.pendingCount()).toBe(0);
  const files = await readdir(directory);
  expect(files).toHaveLength(1);
  expect(JSON.parse(await readFile(path.join(directory, files[0]!), "utf8"))).toMatchObject({
    state: "completed",
    agentId: "parent",
  });
});
