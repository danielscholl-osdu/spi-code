// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { BriefingSchema } from "./briefing.js";
import {
  AREAS,
  AreaEnvelopeSchema,
  ObservedAtSchema,
  ReadRecordSchema,
  resolvePointer,
  ValueSourceSchema,
} from "./evidence.js";
import { ReleaseLineSchema } from "./panes.js";
import { StationsSchema } from "./stations.js";
import { SelectionIdSchema, TreeStatusSchema } from "./tree.js";

export const ReleasesPaneSchema = z.strictObject({
  lines: z.array(ReleaseLineSchema),
  reading: z.boolean(),
});
export const ViewSnapshotSchema = z
  .strictObject({
    cursor: z.int().nonnegative(),
    sweptAt: ObservedAtSchema,
    briefing: BriefingSchema,
    releases: ReleasesPaneSchema,
    stations: StationsSchema,
    tree: TreeStatusSchema,
    reads: z.array(ReadRecordSchema),
    areas: z.array(AreaEnvelopeSchema),
    provenance: z.array(ValueSourceSchema),
    selection: SelectionIdSchema.nullable(),
  })
  .superRefine((snapshot, ctx) => {
    const seen = new Set<string>();
    snapshot.areas.forEach(({ area, envelope }, index) => {
      if (seen.has(area)) {
        ctx.addIssue({ code: "custom", message: `Area ${area} repeats`, path: ["areas", index] });
      }
      if (envelope.source !== area) {
        ctx.addIssue({
          code: "custom",
          message: `Envelope source ${envelope.source} is not area ${area}`,
          path: ["areas", index, "envelope", "source"],
        });
      }
      seen.add(area);
    });
    for (const area of AREAS) {
      if (!seen.has(area)) {
        ctx.addIssue({ code: "custom", message: `Area ${area} has no envelope`, path: ["areas"] });
      }
    }
    const paths = new Set<string>();
    snapshot.provenance.forEach(({ path, areas }, index) => {
      if (paths.has(path)) {
        ctx.addIssue({
          code: "custom",
          message: `Provenance repeats ${path}`,
          path: ["provenance", index, "path"],
        });
      }
      paths.add(path);
      if (!resolvePointer(snapshot, path).found) {
        ctx.addIssue({
          code: "custom",
          message: `Provenance path ${path} does not resolve`,
          path: ["provenance", index, "path"],
        });
      }
      for (const area of areas) {
        if (!seen.has(area)) {
          ctx.addIssue({
            code: "custom",
            message: `Provenance names area ${area} with no envelope`,
            path: ["provenance", index, "areas"],
          });
        }
      }
    });
  });

export type ReleasesPane = z.infer<typeof ReleasesPaneSchema>;
export type ViewSnapshot = z.infer<typeof ViewSnapshotSchema>;
