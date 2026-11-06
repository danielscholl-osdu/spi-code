// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { WatchItemSchema } from "./briefing.js";
import { IdentifierSchema } from "./evidence.js";

export const StationSubstateSchema = z.enum([
  "stopped",
  "waiting-on-person",
  "waiting-on-clock",
  "in-progress",
  "ready",
]);
export const CampaignSchema = z.strictObject({
  id: IdentifierSchema,
  kind: z.enum(["toolchain", "engineering", "security", "halt", "port", "deadline"]),
  fact: IdentifierSchema,
  forks: z
    .array(IdentifierSchema)
    .min(2)
    .refine((forks) => new Set(forks).size === forks.length, "Campaign forks repeat"),
});
export const AnchorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.enum(["program", "upstream", "environment", "engineering", "releases", "security"]),
  }),
  z.strictObject({ kind: z.literal("service"), id: IdentifierSchema }),
  z.strictObject({
    kind: z.literal("release-month"),
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  }),
  z.strictObject({ kind: z.literal("campaign"), id: IdentifierSchema }),
]);
export const ReadingTileSchema = z.strictObject({
  label: IdentifierSchema,
  value: IdentifierSchema,
  counts: IdentifierSchema,
});
export const ReadingSchema = z.strictObject({
  anchor: AnchorSchema,
  content: z
    .strictObject({
      headline: IdentifierSchema,
      qualifier: IdentifierSchema.optional(),
      tiles: z.tuple([ReadingTileSchema, ReadingTileSchema, ReadingTileSchema]),
      items: z.array(WatchItemSchema.extend({ group: IdentifierSchema })).max(5),
      folded: IdentifierSchema.nullable(),
    })
    .nullable(),
});
export const SeenStateSchema = z.strictObject({
  cursor: z.int().nonnegative().nullable(),
  since: z.array(IdentifierSchema),
});
export const ViewAcknowledgeSchema = z.strictObject({ cursor: z.int().nonnegative() });

export type StationSubstate = z.infer<typeof StationSubstateSchema>;
export type Campaign = z.infer<typeof CampaignSchema>;
export type Anchor = z.infer<typeof AnchorSchema>;
export type Reading = z.infer<typeof ReadingSchema>;
export type SeenState = z.infer<typeof SeenStateSchema>;
