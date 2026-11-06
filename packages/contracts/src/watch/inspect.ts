// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import {
  AREAS,
  AreaEnvelopeSchema,
  IdentifierSchema,
  ReadRecordSchema,
  resolvePointer,
  ValueSourceSchema,
} from "./evidence.js";
import { SelectionIdSchema } from "./tree.js";

export const WebUrlSchema = z.url({ protocol: /^https?$/ });
export const FailureClassSchema = z.enum([
  "ENV",
  "ACCESS",
  "TEST",
  "HALT",
  "TOOLCHAIN",
  "CONFLICT",
  "POLICY",
  "INFRA",
  "BUILD",
  "UNREAD",
]);
// Mirrors core's ItemClass: every queue item, not only failures, can be inspected.
export const ItemClassSchema = z.enum([
  ...FailureClassSchema.options,
  "PORT",
  "SECURITY",
  "ROLLOUT",
  "INCIDENT",
  "GATE",
  "READY",
]);
export const ActionItemSchema = z.strictObject({
  id: IdentifierSchema,
  label: IdentifierSchema,
  disabledReason: IdentifierSchema,
  eligibilityReason: IdentifierSchema.optional(),
});
export const RelatedSchema = z.strictObject({
  text: z.string(),
  state: z.string(),
  inspect: SelectionIdSchema.optional(),
  url: WebUrlSchema.optional(),
});
export const ApprovalSchema = z.strictObject({
  id: IdentifierSchema,
  state: z.enum(["pending", "approved", "rejected"]),
  reason: IdentifierSchema,
});
export const InspectRequestSchema = z.strictObject({ id: SelectionIdSchema });
// EV-03: areas and provenance travel together; a result without them predates per-value evidence.
export const InspectResultSchema = z
  .strictObject({
    id: SelectionIdSchema,
    title: z.string().optional(),
    class: ItemClassSchema,
    cause: z.string(),
    effect: z.string(),
    next: z.string(),
    why: z.string(),
    evidence: z.array(ReadRecordSchema),
    related: z.array(RelatedSchema),
    approval: ApprovalSchema.nullable(),
    actions: z.array(ActionItemSchema),
    areas: z.array(AreaEnvelopeSchema).optional(),
    provenance: z.array(ValueSourceSchema).optional(),
  })
  .superRefine((result, ctx) => {
    const { areas, provenance } = result;
    if ((areas === undefined) !== (provenance === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "Areas and provenance must be present together",
        path: [areas === undefined ? "areas" : "provenance"],
      });
    }
    const seen = new Set<string>();
    areas?.forEach(({ area, envelope }, index) => {
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
    if (areas !== undefined) {
      for (const area of AREAS) {
        if (!seen.has(area)) {
          ctx.addIssue({
            code: "custom",
            message: `Area ${area} has no envelope`,
            path: ["areas"],
          });
        }
      }
    }
    const paths = new Set<string>();
    provenance?.forEach(({ path, areas: named }, index) => {
      if (paths.has(path)) {
        ctx.addIssue({
          code: "custom",
          message: `Provenance repeats ${path}`,
          path: ["provenance", index, "path"],
        });
      }
      paths.add(path);
      if (!resolvePointer(result, path).found) {
        ctx.addIssue({
          code: "custom",
          message: `Provenance path ${path} does not resolve`,
          path: ["provenance", index, "path"],
        });
      }
      for (const area of named) {
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
export type InspectResult = z.infer<typeof InspectResultSchema>;
export type ItemClass = z.infer<typeof ItemClassSchema>;
export type ActionItem = z.infer<typeof ActionItemSchema>;
