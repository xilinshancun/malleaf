import { z } from "zod";

// Read-only desktop projection. The controller remains the sole pointer writer.
// Match its portable single-segment epoch names without interpreting new fields.
export const MalleafSelectedPairSchema = z.looseObject({
  buildId: z.string().regex(/^[a-f0-9]{64}$/),
  dataId: z
    .string()
    .min(1)
    .refine(
      (value) =>
        !/[\\/:]/.test(value) &&
        ![...value].some((character) => character.charCodeAt(0) < 32) &&
        !value.startsWith(".") &&
        !value.endsWith(".partial"),
    ),
});

export const MalleafRuntimePointerSelectionSchema = z.looseObject({
  schemaVersion: z.number().int().positive(),
  minReaderVersion: z.number().int().positive(),
  current: MalleafSelectedPairSchema,
  trial: z.looseObject({ pair: MalleafSelectedPairSchema }).nullable(),
});
export type MalleafSelectedPair = z.infer<typeof MalleafSelectedPairSchema>;
