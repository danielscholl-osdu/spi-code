// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { IdentifierSchema } from "./evidence.js";

export const StationIdSchema = z.enum(["upstream", "sync", "cascade", "main", "release", "lane"]);
export const StationSchema = z.strictObject({
  id: StationIdSchema,
  state: z.enum(["idle", "moving", "waiting", "stopped", "unknown"]),
  text: z.string(),
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
