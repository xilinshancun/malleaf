import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { acceptanceStatus, createAcceptanceSession } from "./acceptance-session.js";
import type { RuntimePointer } from "./pointer.js";

const original = "a".repeat(64);
const pointer: RuntimePointer = {
  schemaVersion: 1,
  minReaderVersion: 1,
  minWriterVersion: 1,
  seq: 2,
  current: { buildId: "b".repeat(64), dataId: "candidate" },
  previous: { buildId: original, dataId: "baseline" },
  trial: null,
  updatedAt: new Date().toISOString(),
  writer: { pid: process.pid, token: randomUUID() },
};
const request = (command: "keep" | "status") => ({
  type: "malleaf.controller.request",
  requestId: randomUUID(),
  command,
  params: command === "keep" ? { switchId: randomUUID() } : {},
});

test("status failure after a committed keep still replies successfully and hands off", async () => {
  const send = vi.fn(async () => true);
  const onHandoff = vi.fn();
  const session = createAcceptanceSession({
    buildId: original,
    send,
    onHandoff,
    isStopping: () => false,
    execute: async () => ({
      pointer,
      ...(await acceptanceStatus(async () => {
        throw new Error("status unavailable");
      })),
    }),
  });
  await session.handle(request("keep"));
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      ok: true,
      value: { pointer, status: null, statusError: "Error: status unavailable" },
    }),
  );
  expect(onHandoff).toHaveBeenCalledOnce();
});

test("keep refuses new commands before its reply, then notifies handoff after the reply", async () => {
  const keep = request("keep");
  const status = request("status");
  const sent: object[] = [];
  const execute = vi.fn(async () => ({ pointer }));
  const onHandoff = vi.fn();
  const session = createAcceptanceSession({
    buildId: original,
    execute,
    onHandoff,
    isStopping: () => false,
    send: async (message) => {
      sent.push(message);
      if ("requestId" in message && message.requestId === keep.requestId)
        await session.handle(status);
      return true;
    },
  });
  await session.handle(keep);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(sent).toEqual([
    expect.objectContaining({ requestId: keep.requestId, ok: true }),
    expect.objectContaining({
      requestId: status.requestId,
      ok: false,
      error: expect.objectContaining({ code: "handoff_in_progress" }),
    }),
    { type: "malleaf.controller.handoff", switchId: keep.params.switchId, next: pointer.current },
  ]);
  expect(onHandoff).toHaveBeenCalledOnce();
});

test.each(["reply", "notification"])(
  "failed %s delivery keeps the committed controller available",
  async (failure) => {
    const execute = vi.fn(async () => ({ pointer }));
    const onHandoff = vi.fn();
    const session = createAcceptanceSession({
      buildId: original,
      execute,
      onHandoff,
      isStopping: () => false,
      send: async (message) =>
        "type" in message &&
        message.type !==
          (failure === "reply" ? "malleaf.controller.result" : "malleaf.controller.handoff"),
    });
    await session.handle(request("keep"));
    await session.handle(request("status"));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(onHandoff).not.toHaveBeenCalled();
  },
);

test("queued commands cannot execute after keep starts handoff", async () => {
  const execute = vi.fn(async () => ({ pointer }));
  const send = vi.fn(async () => true);
  const session = createAcceptanceSession({
    buildId: original,
    execute,
    send,
    onHandoff: () => {},
    isStopping: () => false,
  });
  await Promise.all([session.handle(request("keep")), session.handle(request("status"))]);
  expect(execute).toHaveBeenCalledOnce();
  expect(send).toHaveBeenLastCalledWith(
    expect.objectContaining({ error: expect.objectContaining({ code: "handoff_in_progress" }) }),
  );
});

test("failed keep and invalid IPC input never request handoff", async () => {
  const onHandoff = vi.fn();
  const execute = vi.fn(async () => {
    throw new Error("keep failed");
  });
  const send = vi.fn(async () => true);
  const session = createAcceptanceSession({
    buildId: original,
    execute,
    send,
    onHandoff,
    isStopping: () => false,
  });
  await session.handle({ ...request("keep"), params: { switchId: "invalid" } });
  expect(execute).not.toHaveBeenCalled();
  await session.handle(request("keep"));
  expect(send).toHaveBeenLastCalledWith(
    expect.objectContaining({
      ok: false,
      error: { code: "state_conflict", message: "keep failed" },
    }),
  );
  expect(onHandoff).not.toHaveBeenCalled();
});
