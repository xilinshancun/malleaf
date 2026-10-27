import { z } from "zod";

export const MalleafRuntimeIdentitySchema = z.object({
  product: z.string().min(1),
  display: z.string().min(1),
  buildId: z.string().regex(/^[a-f0-9]{64}$/),
  upstream: z.string().regex(/^[a-f0-9]{40,64}$/),
});
export type MalleafRuntimeIdentity = z.infer<typeof MalleafRuntimeIdentitySchema>;
