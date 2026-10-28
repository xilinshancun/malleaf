import { z } from "zod";
import { runtimePairSchema, type RuntimePointer } from "./pointer.js";

const envelope = { type: z.literal("malleaf.controller.request"), requestId: z.string().uuid() };
const switchParams = z.strictObject({
  switchId: z.string().uuid(),
  switchToken: z.string().uuid(),
  drainId: z.string().uuid(),
  candidate: runtimePairSchema,
  copySource: runtimePairSchema,
});
export const acceptanceRequestSchema = z.discriminatedUnion("command", [
  z.strictObject({ ...envelope, command: z.literal("activate"), params: switchParams }),
  z.strictObject({
    ...envelope,
    command: z.literal("keep"),
    params: z.strictObject({ switchId: z.string().uuid() }),
  }),
  z.strictObject({
    ...envelope,
    command: z.literal("revert"),
    params: z.strictObject({ switchId: z.string().uuid() }),
  }),
  z.strictObject({ ...envelope, command: z.literal("status"), params: z.strictObject({}) }),
]);
export type AcceptanceRequest = z.infer<typeof acceptanceRequestSchema>;
export interface AcceptanceValue {
  pointer: RuntimePointer;
  [key: string]: unknown;
}

// Diagnostics cannot turn an already committed keep into a failed reply.
export async function acceptanceStatus<T>(read: () => Promise<T>) {
  try {
    return { status: await read(), statusError: null };
  } catch (error) {
    return { status: null, statusError: String(error) };
  }
}

// Private parent IPC for isolated acceptance. It is never served by the public
// identify socket, and boot constructs it only after all acceptance guards.
export function createAcceptanceSession(options: {
  buildId: string;
  execute(request: AcceptanceRequest): Promise<AcceptanceValue>;
  send(message: object): Promise<boolean>;
  isStopping(): boolean;
  onHandoff(): void;
}) {
  let handoffPending = false;
  let tail = Promise.resolve();
  async function rejectRequest(requestId: string, code: string, message: string) {
    await options.send({
      type: "malleaf.controller.result",
      requestId,
      ok: false,
      error: { code, message },
    });
  }
  async function run(request: AcceptanceRequest) {
    if (handoffPending)
      return rejectRequest(
        request.requestId,
        "handoff_in_progress",
        "Controller handoff is in progress",
      );
    if (options.isStopping())
      return rejectRequest(request.requestId, "daemon_stopping", "Controller is stopping");
    try {
      const value = await options.execute(request);
      const shouldHandoff =
        request.command === "keep" &&
        value.pointer.current.buildId !== options.buildId &&
        !options.isStopping();
      if (shouldHandoff) handoffPending = true;
      const delivered = await options.send({
        type: "malleaf.controller.result",
        requestId: request.requestId,
        ok: true,
        value,
      });
      if (!shouldHandoff) return;
      if (!delivered) {
        handoffPending = false;
        return;
      }
      const notified = await options.send({
        type: "malleaf.controller.handoff",
        switchId: request.params.switchId,
        next: value.pointer.current,
      });
      if (notified && !options.isStopping()) options.onHandoff();
      else handoffPending = false;
    } catch (error) {
      handoffPending = false;
      const code =
        error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : "state_conflict";
      await rejectRequest(
        request.requestId,
        code,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return {
    handle(message: unknown): Promise<void> {
      const parsed = acceptanceRequestSchema.safeParse(message);
      if (!parsed.success) {
        const requestId =
          typeof message === "object" &&
          message &&
          "requestId" in message &&
          typeof message.requestId === "string"
            ? message.requestId.slice(0, 100)
            : "invalid";
        return rejectRequest(requestId, "invalid_state", "Invalid acceptance command");
      }
      if (handoffPending)
        return rejectRequest(
          parsed.data.requestId,
          "handoff_in_progress",
          "Controller handoff is in progress",
        );
      const result = tail.then(() => run(parsed.data));
      tail = result.catch(() => {});
      return result;
    },
    settle: () => tail,
  };
}
