// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { WatchItemSchema } from "./briefing.js";
import { IdentifierSchema, ObservedAtSchema } from "./evidence.js";

export const StationSubstateSchema = z.enum([
  "stopped",
  "waiting-on-person",
  "waiting-on-clock",
  "in-progress",
  "ready",
]);
export const CampaignSchema = z
  .strictObject({
    id: IdentifierSchema,
    kind: z.enum(["toolchain", "engineering", "security", "halt", "port", "deadline"]),
    fact: IdentifierSchema,
    forks: z
      .array(IdentifierSchema)
      .min(2)
      .refine((forks) => new Set(forks).size === forks.length, "Campaign forks repeat"),
    /** Members whose move is predicted only by an open upstream MR; all other forks are certain. */
    possible: z.array(IdentifierSchema).optional(),
  })
  .refine(
    ({ forks, possible }) =>
      !possible ||
      (new Set(possible).size === possible.length &&
        possible.every((fork) => forks.includes(fork))),
    { message: "Possible campaign forks must be unique members", path: ["possible"] },
  );
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
      verifiedTemplate: z
        .strictObject({
          verified: z.int().nonnegative(),
          total: z.int().nonnegative(),
          unread: z.int().nonnegative(),
          target: IdentifierSchema,
        })
        .refine(({ verified, total, unread }) => verified + unread <= total, {
          message: "Verified and unread forks exceed the fleet total",
        })
        .optional(),
    })
    .nullable(),
});
export const SeenStateSchema = z.strictObject({
  cursor: z.int().nonnegative().nullable(),
  since: z.array(IdentifierSchema),
  at: ObservedAtSchema.optional(),
});
export const ViewAcknowledgeSchema = z.strictObject({ cursor: z.int().nonnegative() });

export type StationSubstate = z.infer<typeof StationSubstateSchema>;
export type Campaign = z.infer<typeof CampaignSchema>;
export type Anchor = z.infer<typeof AnchorSchema>;
export type Reading = z.infer<typeof ReadingSchema>;
export type SeenState = z.infer<typeof SeenStateSchema>;
export type ViewAcknowledge = z.infer<typeof ViewAcknowledgeSchema>;
