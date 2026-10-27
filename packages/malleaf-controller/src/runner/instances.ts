import path from "node:path";
import { z } from "zod";
import { type DaemonInstance, isSameDaemonInstance } from "@getpaseo/server/daemon-control";
import { assertStoragePath } from "../isolation.js";
import { StorageError, prospectiveRealPath } from "../storage.js";
import { documentSchema, initialDocument, openOwnedDocument } from "./document.js";
import { runtimePairSchema } from "./pointer.js";

const roleSchema = z.enum(["baseline", "candidate", "preflight"]);
export type InstanceRole = z.infer<typeof roleSchema>;
const launchSchema = z.looseObject({
  home: z.string().refine(path.isAbsolute),
  buildId: runtimePairSchema.shape.buildId,
  token: z.string().uuid(),
  at: z.string().datetime(),
  bootDrainId: z.string().uuid().optional(),
});
const instanceSchema = z.looseObject({
  pid: z.number().int().positive(),
  startedAt: z.string().datetime(),
  hostname: z.string(),
  uid: z.number(),
  listen: z.string().nullable(),
  serverId: z.string().nullable().optional(),
});
const registrationSchema = launchSchema.extend({ instance: instanceSchema.nullable() });
export type InstanceRegistration = z.infer<typeof registrationSchema>;
const ledgerSchema = documentSchema.extend({
  registrations: z.partialRecord(roleSchema, registrationSchema),
});
export type InstanceLedgerState = z.infer<typeof ledgerSchema>;
interface LedgerOptions {
  home: string;
  assertOwned(): void;
}
type LaunchIntent = Pick<InstanceRegistration, "home" | "buildId" | "token" | "bootDrainId">;

export function matchesRegisteredInstance(
  registration: InstanceRegistration,
  home: string,
  live: DaemonInstance,
): boolean {
  return (
    registration.home === home &&
    registration.instance !== null &&
    isSameDaemonInstance(registration.instance, live)
  );
}

export async function openInstanceLedger(options: LedgerOptions) {
  const store = await openOwnedDocument({
    ...options,
    name: "instances.json",
    schema: ledgerSchema,
    initial: { ...initialDocument(), registrations: {} },
  });
  return {
    read: store.read,
    seal: store.seal,
    async intent(role: InstanceRole, input: LaunchIntent) {
      assertStoragePath(input.home);
      const home = await prospectiveRealPath(input.home);
      const registration = registrationSchema.parse({
        ...input,
        home,
        at: new Date().toISOString(),
        instance: null,
      });
      return store.update((state) => {
        if (state.registrations[role])
          throw new StorageError(
            "state_conflict",
            `An uncleared ${role} launch is already registered`,
          );
        return { ...state, registrations: { ...state.registrations, [role]: registration } };
      });
    },
    acquired(role: InstanceRole, token: string, instance: DaemonInstance) {
      const parsed = instanceSchema.parse(instance);
      return store.update((state) => {
        const previous = state.registrations[role];
        if (!previous || previous.token !== token)
          throw new StorageError("state_conflict", `Launch intent changed for ${role}`);
        if (previous.instance && !isSameDaemonInstance(previous.instance, parsed))
          throw new StorageError(
            "state_conflict",
            `Registered ${role} instance cannot be replaced`,
          );
        return {
          ...state,
          registrations: {
            ...state.registrations,
            [role]: { ...previous, instance: { ...previous.instance, ...parsed } },
          },
        };
      });
    },
    clear(role: InstanceRole, token: string) {
      return store.update((state) => {
        const previous = state.registrations[role];
        if (!previous) return state;
        if (previous.token !== token)
          throw new StorageError("state_conflict", `Cannot clear a different ${role} launch`);
        const registrations = { ...state.registrations };
        delete registrations[role];
        return { ...state, registrations };
      });
    },
    promote(token: string) {
      return store.update((state) => {
        const candidate = state.registrations.candidate;
        if (!candidate?.instance || candidate.token !== token || state.registrations.baseline)
          throw new StorageError(
            "state_conflict",
            "Candidate cannot replace the baseline registration",
          );
        const registrations = { ...state.registrations, baseline: candidate };
        delete registrations.candidate;
        return { ...state, registrations };
      });
    },
  };
}
