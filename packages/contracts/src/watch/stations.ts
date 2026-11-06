// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { IdentifierSchema, ObservedAtSchema } from "./evidence.js";
import { WebUrlSchema } from "./inspect.js";
import { DocRowSchema } from "./panes.js";
import { StationSubstateSchema } from "./reading.js";
import { SelectionIdSchema } from "./tree.js";

export const StationIdSchema = z.enum(["upstream", "sync", "cascade", "main", "release", "lane"]);
const StationStateSchema = z.enum(["idle", "moving", "waiting", "stopped", "unknown"]);
export const StationSchema = z.strictObject({
  id: StationIdSchema,
  state: StationStateSchema,
  substate: StationSubstateSchema,
  text: z.string(),
  inspect: SelectionIdSchema.optional(),
});
export const ServiceRunSchema = z.strictObject({
  id: SelectionIdSchema,
  workflow: z.string(),
  result: z.string(),
  time: ObservedAtSchema,
  url: WebUrlSchema,
});
export const ServiceReleaseSchema = DocRowSchema.extend({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  releasePr: z
    .strictObject({
      number: z.int().positive(),
      title: z.string(),
      url: WebUrlSchema,
    })
    .optional(),
  gate: z.strictObject({ state: StationStateSchema, text: z.string() }).optional(),
});
export const ServiceStationsSchema = z.strictObject({
  service: IdentifierSchema,
  stations: z.tuple([
    StationSchema.extend({ id: z.literal("upstream") }),
    StationSchema.extend({ id: z.literal("sync") }),
    StationSchema.extend({ id: z.literal("cascade") }),
    StationSchema.extend({ id: z.literal("main") }),
    StationSchema.extend({ id: z.literal("release") }),
    StationSchema.extend({ id: z.literal("lane") }),
  ]),
});
export const StationsSchema = z.array(ServiceStationsSchema);
export type Station = z.infer<typeof StationSchema>;
export type ServiceStations = z.infer<typeof ServiceStationsSchema>;
