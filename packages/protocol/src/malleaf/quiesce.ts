import { z } from "zod";

export const MalleafDrainIdSchema = z.string().uuid();
export const MalleafQuiesceStatusSchema = z.object({
  state: z.enum(["accepting", "draining", "shutdown"]),
  drainId: MalleafDrainIdSchema.nullable(),
  expiresAt: z.number().nullable(),
  running: z.array(z.string()),
  pendingPermissions: z.array(z.string()),
  pendingRegistrations: z.number().int().nonnegative(),
  pendingAdmissions: z.number().int().nonnegative(),
  pendingDeliveries: z.number().int().nonnegative(),
  pendingScheduleRuns: z.number().int().nonnegative(),
  terminals: z.number().int().nonnegative(),
  scripts: z.number().int().nonnegative(),
  scheduleError: z.string().nullable(),
});
export type MalleafQuiesceStatus = z.infer<typeof MalleafQuiesceStatusSchema>;

export const DaemonQuiesceRequestSchema = z.object({
  type: z.literal("daemon.quiesce.request"),
  requestId: z.string(),
  action: z.enum(["begin", "end", "status"]),
  drainId: MalleafDrainIdSchema.optional(),
  deadlineMs: z.number().int().min(1000).max(900_000).optional(),
});
export type DaemonQuiesceRequest = z.infer<typeof DaemonQuiesceRequestSchema>;
export const DaemonQuiesceResponseSchema = z.object({
  type: z.literal("daemon.quiesce.response"),
  requestId: z.string(),
  status: MalleafQuiesceStatusSchema,
});
