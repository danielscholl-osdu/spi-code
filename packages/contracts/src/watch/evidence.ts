// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";

export const IdentifierSchema = z.string().min(1);
export const ObservedAtSchema = z.iso.datetime({ offset: true });
export const EvidenceStateSchema = z.enum(["fresh", "stale", "incomplete", "failed", "unread"]);
export const CompletenessSchema = z.union([
  z.strictObject({ kind: z.literal("complete") }),
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
  z.strictObject({
    source: IdentifierSchema,
    state: z.literal("unread"),
    // Core reports an unread area as complete and not inferred; a cut makes no sense with no read.
    completeness: z.strictObject({ kind: z.literal("complete") }).optional(),
    inferred: z.literal(false).optional(),
  }),
  z
    .strictObject({
      source: IdentifierSchema,
      state: z.enum(["fresh", "stale", "incomplete", "failed"]),
      // Absent only when a read failed and nothing earlier was retained.
      observedAt: ObservedAtSchema.optional(),
      completeness: CompletenessSchema,
      inferred: z.boolean().optional(),
    })
    .refine(({ state, observedAt }) => observedAt !== undefined || state === "failed", {
      message: "Only a failed read may lack an observed time",
      path: ["observedAt"],
    })
    // EV-01: an area has one state, so a cut read cannot also claim to be fresh or stale.
    .refine(
      ({ state, completeness }) =>
        completeness.kind === "complete" || state === "incomplete" || state === "failed",
      { message: "A cut read must be incomplete or failed", path: ["state"] },
    ),
]);

export type ReadRecord = z.infer<typeof ReadRecordSchema>;
export type Envelope = z.infer<typeof EnvelopeSchema>;

// Mirrors core's AREAS; a core test keeps the two lists equal (contracts stay core-free).
export const AREAS = Object.freeze([
  "fleet",
  "github",
  "runs",
  "approvals",
  "lifecycle",
  "details",
  "upstream",
  "radar",
  "template",
  "auth",
  "security",
] as const);
export const AreaNameSchema = z.enum(AREAS);
export const AreaEnvelopeSchema = z.strictObject({
  area: AreaNameSchema,
  envelope: EnvelopeSchema,
});
export const JsonPointerSchema = z.string().regex(/^(\/([^~/]|~[01])*)+$/, {
  message: "Expected an RFC 6901 JSON pointer below the root",
});
export const ValueSourceSchema = z.strictObject({
  path: JsonPointerSchema,
  areas: z
    .array(AreaNameSchema)
    .min(1)
    .refine((areas) => new Set(areas).size === areas.length, { message: "Areas repeat" }),
});

/** Resolves an RFC 6901 pointer; array indices must be canonical and in range. */
export function resolvePointer(
  document: unknown,
  pointer: string,
): { found: boolean; value?: unknown } {
  if (pointer === "") return { found: true, value: document };
  if (!pointer.startsWith("/")) return { found: false };
  let current = document;
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(token) || Number(token) >= current.length) return { found: false };
      current = current[Number(token)];
    } else if (current !== null && typeof current === "object" && Object.hasOwn(current, token)) {
      current = (current as Record<string, unknown>)[token];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

export type AreaName = z.infer<typeof AreaNameSchema>;
export type AreaEnvelope = z.infer<typeof AreaEnvelopeSchema>;
export type ValueSource = z.infer<typeof ValueSourceSchema>;
