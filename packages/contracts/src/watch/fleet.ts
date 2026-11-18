// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { ObservedAtSchema } from "./evidence.js";

export const ServiceHomeStationIdSchema = z.enum(["upstream", "sync", "integration", "main"]);
export const ServiceHomeDoorIdSchema = z.enum(["template", "release", "dependabot", "other"]);
export const TodayMemberStationSchema = z.enum(["upstream", "sync", "integration", "template"]);
export type TodayMemberStation = z.infer<typeof TodayMemberStationSchema>;

const Count = z.int().nonnegative();
const Forks = z.array(z.string());
const Figure = z.strictObject({
  // Confirmed count. If reads are missing, the display keeps a positive count and marks it partial.
  count: Count,
  forks: Forks,
  notRead: Forks,
});
const CauseKindSchema = z.enum(["release", "dependabot", "other", "issue", "alert"]);
const CauseSchema = z.strictObject({
  id: z.string(),
  kind: CauseKindSchema,
  headline: z.string(),
  count: Count,
  forkCount: Count,
  place: z.enum(["releases", "security"]).optional(),
  forks: z.array(
    z.strictObject({
      fork: z.string(),
      count: Count,
      objects: z.array(
        z.strictObject({
          id: z.string(),
          url: z.string(),
          label: z.string(),
          age: z.string().optional(),
          count: z.int().positive(),
        }),
      ),
    }),
  ),
  packages: z
    .array(z.strictObject({ ecosystem: z.string(), name: z.string(), forks: Forks }))
    .optional(),
  rules: z
    .strictObject({
      mostAlerts: z.strictObject({ name: z.string(), count: Count }),
      mostForks: z.strictObject({ name: z.string(), count: Count }),
    })
    .optional(),
});
export const CanWaitCausesSchema = z.strictObject({
  rows: z.array(CauseSchema),
  notRead: z.strictObject({
    release: Forks,
    dependabot: Forks,
    other: Forks,
    issue: Forks,
    alert: Forks,
  }),
});

const StationFigure = Figure.extend({
  id: ServiceHomeStationIdSchema,
  stopped: Forks,
  inProgress: Forks,
  // Integration also holds merged syncs waiting for the cascade.
  waitingOnClock: Forks,
  waitingOnPerson: Forks,
});
const DoorFigure = Figure.extend({
  id: ServiceHomeDoorIdSchema,
  target: z
    .union([
      z.strictObject({ kind: z.literal("station"), station: z.literal("template") }),
      z.strictObject({ kind: z.literal("cause"), row: z.string() }),
    ])
    .optional(),
});
export const TodayFleetSchema = z.strictObject({
  stations: z.array(StationFigure),
  doors: z.array(DoorFigure),
  nextSyncAt: ObservedAtSchema.optional(),
  environment: z.strictObject({
    state: z.enum(["ready", "maintenance", "unread"]),
    version: z.string().optional(),
  }),
  forks: z.strictObject({
    // Row keys into services[].home, grouped in fleet order.
    yours: Forks,
    stopped: Forks,
    rest: z.strictObject({
      forks: Forks,
      stations: z.array(StationFigure),
      doors: z.array(DoorFigure.omit({ target: true })),
    }),
  }),
});

export type CanWaitCause = z.infer<typeof CauseSchema>;
export type CanWaitCauses = z.infer<typeof CanWaitCausesSchema>;
export type TodayFleet = z.infer<typeof TodayFleetSchema>;
