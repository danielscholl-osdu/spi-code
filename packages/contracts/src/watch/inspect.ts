// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { IdentifierSchema, ReadRecordSchema } from "./evidence.js";
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
export const InspectResultSchema = z.strictObject({
  id: SelectionIdSchema,
  class: ItemClassSchema,
  cause: z.string(),
  effect: z.string(),
  next: z.string(),
  why: z.string(),
  evidence: z.array(ReadRecordSchema),
  related: z.array(RelatedSchema),
  approval: ApprovalSchema.nullable(),
  actions: z.array(ActionItemSchema),
});
export type InspectResult = z.infer<typeof InspectResultSchema>;
export type ItemClass = z.infer<typeof ItemClassSchema>;
export type ActionItem = z.infer<typeof ActionItemSchema>;
