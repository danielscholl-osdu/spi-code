// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { BriefingSchema } from "./briefing.js";
import { ObservedAtSchema, ReadRecordSchema } from "./evidence.js";
import { ReleaseLineSchema } from "./panes.js";
import { StationsSchema } from "./stations.js";
import { SelectionIdSchema, TreeStatusSchema } from "./tree.js";

export const ReleasesPaneSchema = z.strictObject({
  lines: z.array(ReleaseLineSchema),
  reading: z.boolean(),
});
export const ViewSnapshotSchema = z.strictObject({
  cursor: z.int().nonnegative(),
  sweptAt: ObservedAtSchema,
  briefing: BriefingSchema,
  releases: ReleasesPaneSchema,
  stations: StationsSchema,
  tree: TreeStatusSchema,
  reads: z.array(ReadRecordSchema),
  selection: SelectionIdSchema.nullable(),
});

export type ReleasesPane = z.infer<typeof ReleasesPaneSchema>;
export type ViewSnapshot = z.infer<typeof ViewSnapshotSchema>;
