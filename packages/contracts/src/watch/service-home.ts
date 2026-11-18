// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { LinkSchema } from "./briefing.js";
import { ObservedAtSchema } from "./evidence.js";

const PullSchema = z.strictObject({ number: z.int().positive(), url: z.string() });
const StationIdSchema = z.enum(["upstream", "sync", "integration", "main"]);
const DoorIdSchema = z.enum(["template", "release", "other", "dependabot"]);
const StationSchema = z.strictObject({
  id: StationIdSchema,
  state: z.enum([
    "stopped",
    "waiting-on-person",
    "in-progress",
    "waiting-on-clock",
    "unread",
    "ready",
    "green",
  ]),
  word: z.string(),
  line: z.string().optional(),
  pr: PullSchema.optional(),
  lastMerge: PullSchema.extend({ at: ObservedAtSchema }).optional(),
  nextAt: ObservedAtSchema.optional(),
  inTransit: z.boolean().optional(),
  row: z.string().optional(),
});
const DoorSchema = z.strictObject({
  id: DoorIdSchema,
  count: z.int().nonnegative().nullable(),
  prs: z.array(PullSchema),
  row: z.string().optional(),
});
const OverviewRowSchema = z.strictObject({
  id: z.string(),
  section: z.enum(["blocked", "waiting", "shared", "can-wait"]),
  headline: z.string(),
  cause: z.string(),
  effect: z.string().optional(),
  steps: z.array(z.string()),
  links: z.array(LinkSchema),
  since: ObservedAtSchema.optional(),
});
const MarkSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("count"),
    count: z.int().positive(),
    tone: z.enum(["error", "warning"]),
  }),
  z.strictObject({ kind: z.enum(["check", "unread"]) }),
]);

export const ServiceHomeSchema = z.strictObject({
  repo: z.string(),
  released: z.string().optional(),
  next: z.string().optional(),
  bump: z.enum(["patch", "minor", "major"]).optional(),
  releasePr: PullSchema.optional(),
  template: z.enum(["current", "behind", "unknown"]),
  stations: z.array(StationSchema),
  doors: z.array(DoorSchema),
  openPrTotal: z.int().nonnegative().optional(),
  overview: z.array(OverviewRowSchema),
  mark: MarkSchema,
});

export type ServiceHome = z.infer<typeof ServiceHomeSchema>;
export type ServiceHomeStation = z.infer<typeof StationSchema>;
export type ServiceHomeDoor = z.infer<typeof DoorSchema>;
export type ServiceHomeRow = z.infer<typeof OverviewRowSchema>;
