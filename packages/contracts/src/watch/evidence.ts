// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";

export const IdentifierSchema = z.string().min(1);
export const ObservedAtSchema = z.iso.datetime({ offset: true });
export const EvidenceStateSchema = z.enum(["fresh", "stale", "incomplete", "failed", "unread"]);
export const CompletenessSchema = z.union([
  z.literal("complete"),
  z
    .strictObject({
      kind: z.literal("cut"),
      reason: IdentifierSchema,
      read: z.int().nonnegative(),
      total: z.int().nonnegative(),
    })
    .refine(({ read, total }) => read <= total, { message: "Read count exceeds total" }),
]);
export const ReadRecordSchema = z.strictObject({
  source: IdentifierSchema,
  object: IdentifierSchema,
  observedAt: ObservedAtSchema,
  completeness: CompletenessSchema,
  failure: IdentifierSchema.optional(),
  retainedFrom: ObservedAtSchema.optional(),
  inferred: z.boolean().optional(),
});
export const EnvelopeSchema = z.union([
  z.strictObject({ source: IdentifierSchema, state: z.literal("unread") }),
  z.strictObject({
    source: IdentifierSchema,
    state: z.enum(["fresh", "stale", "incomplete", "failed"]),
    observedAt: ObservedAtSchema,
    completeness: CompletenessSchema,
  }),
]);

export type ReadRecord = z.infer<typeof ReadRecordSchema>;
export type Envelope = z.infer<typeof EnvelopeSchema>;
