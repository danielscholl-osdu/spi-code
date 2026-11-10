// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { WatchBriefingSchema } from "./briefing.js";
import {
  AREAS,
  AreaEnvelopeSchema,
  IdentifierSchema,
  ObservedAtSchema,
  ReadRecordSchema,
  resolvePointer,
  ValueSourceSchema,
} from "./evidence.js";
import { FormingSchema, ReleaseLineSchema, ReleasesTodaySchema } from "./panes.js";
import { CampaignSchema, ReadingSchema, SeenStateSchema } from "./reading.js";
import { ServiceReleaseSchema, ServiceRunSchema, StationsSchema } from "./stations.js";
import { SelectionIdSchema, TreeStatusSchema } from "./tree.js";

export const ReleasesPaneSchema = z.strictObject({
  lines: z.array(ReleaseLineSchema),
  reading: z.boolean(),
  today: ReleasesTodaySchema.optional(),
  forming: FormingSchema.optional(),
});
/** How far back a workflow's bounded run history reaches; cut when the bound left older runs unread. */
export const RunHistorySchema = z.strictObject({
  workflow: IdentifierSchema,
  reach: ObservedAtSchema,
  cut: z.boolean(),
});
export const ViewSnapshotSchema = z
  .strictObject({
    cursor: z.int().nonnegative(),
    sweptAt: ObservedAtSchema,
    briefing: WatchBriefingSchema,
    campaigns: z.array(CampaignSchema),
    readings: z.array(ReadingSchema),
    seen: SeenStateSchema,
    releases: ReleasesPaneSchema,
    stations: StationsSchema,
    services: z
      .array(
        z.strictObject({
          service: IdentifierSchema,
          runs: z.array(ServiceRunSchema),
          releases: z.array(ServiceReleaseSchema),
          history: z
            .array(RunHistorySchema)
            .refine((rows) => new Set(rows.map(({ workflow }) => workflow)).size === rows.length, {
              message: "Run history repeats a workflow",
            })
            .optional(),
        }),
      )
      .optional(),
    tree: TreeStatusSchema,
    reads: z.array(ReadRecordSchema),
    areas: z.array(AreaEnvelopeSchema),
    provenance: z.array(ValueSourceSchema),
    selection: SelectionIdSchema.nullable(),
  })
  .superRefine((snapshot, ctx) => {
    const anchors = new Set<string>();
    snapshot.readings.forEach(({ anchor }, index) => {
      const key =
        anchor.kind === "service" || anchor.kind === "campaign"
          ? `${anchor.kind}:${anchor.id}`
          : anchor.kind === "release-month"
            ? `${anchor.kind}:${anchor.month}`
            : anchor.kind;
      if (anchors.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: `Reading anchor ${key} repeats`,
          path: ["readings", index, "anchor"],
        });
      }
      anchors.add(key);
    });
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
export type RunHistory = z.infer<typeof RunHistorySchema>;
export type ViewSnapshot = z.infer<typeof ViewSnapshotSchema>;
