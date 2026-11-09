// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { IdentifierSchema, ObservedAtSchema } from "./evidence.js";
import { InspectRequestSchema, InspectResultSchema } from "./inspect.js";
import { ViewAcknowledgeSchema } from "./reading.js";
import {
  SetupCheckSchema,
  SetupInstallSchema,
  SetupSigninCancelSchema,
  SetupSigninProgressSchema,
  SetupSigninSchema,
  SetupStateSchema,
} from "./setup.js";
import { ViewSnapshotSchema } from "./snapshot.js";

export const PROTOCOL_VERSION = 2;
export const SweepStatusSchema = z.strictObject({
  remaining: z.int().nonnegative().nullable(),
  floor: z.int().nonnegative().optional(),
  resetAt: ObservedAtSchema.nullable(),
  deferredAreas: z.array(z.strictObject({ area: IdentifierSchema, reason: IdentifierSchema })),
});
/** Reasons are safe codes or plain text the host chose, never command output. */
export const SWEEP_REASON_MAX_LENGTH = 200;
export const SweepReasonSchema = z.string().min(1).max(SWEEP_REASON_MAX_LENGTH);
export const SweepSourceStateSchema = z.enum([
  "waiting",
  "reading",
  "read",
  "cut",
  "deferred",
  "skipped",
  "failed",
]);
export const SweepSourceProgressSchema = z.strictObject({
  source: IdentifierSchema,
  state: SweepSourceStateSchema,
  startedAt: ObservedAtSchema.optional(),
  endedAt: ObservedAtSchema.optional(),
  reason: SweepReasonSchema.optional(),
  resumeAt: ObservedAtSchema.optional(),
  incomplete: z
    .strictObject({ count: z.int().nonnegative(), total: z.int().positive() })
    .refine(({ count, total }) => count <= total, { message: "Incomplete count exceeds total" })
    .optional(),
});
const sweepProgress = {
  sweep: IdentifierSchema,
  startedAt: ObservedAtSchema,
  first: z.boolean(),
  usualMs: z.int().positive().nullable(),
  sources: z.array(SweepSourceProgressSchema),
};
// The whole current state of one sweep, so a late subscriber needs no history. nextAttemptAt is the
// retry the host has scheduled after a failure, not the GraphQL budget reset in sweep.status.
export const SweepProgressSchema = z
  .discriminatedUnion("outcome", [
    z.strictObject({
      ...sweepProgress,
      outcome: z.enum(["running", "committed", "cancelled"]),
      nextAttemptAt: z.null(),
    }),
    z.strictObject({
      ...sweepProgress,
      outcome: z.literal("failed"),
      failure: SweepReasonSchema,
      nextAttemptAt: ObservedAtSchema.nullable(),
    }),
  ])
  .refine(({ sources }) => new Set(sources.map(({ source }) => source)).size === sources.length, {
    message: "Each source appears once",
    path: ["sources"],
  });
export const SweepRequestSchema = z.strictObject({});
export const ViewSubscribeSchema = z.strictObject({ fromCursor: z.int().nonnegative() });
const envelope = { version: z.literal(PROTOCOL_VERSION), id: IdentifierSchema };
export const WatchMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...envelope,
    kind: z.literal("event"),
    type: z.literal("view.snapshot"),
    payload: ViewSnapshotSchema,
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal("request"),
    type: z.literal("inspect.request"),
    payload: InspectRequestSchema,
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal("response"),
    type: z.literal("inspect.result"),
    payload: InspectResultSchema,
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal("event"),
    type: z.literal("sweep.status"),
    payload: SweepStatusSchema,
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal("event"),
    type: z.literal("sweep.progress"),
    payload: SweepProgressSchema,
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal("request"),
    type: z.literal("sweep.request"),
    payload: SweepRequestSchema,
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal("event"),
    type: z.literal("setup.state"),
    payload: SetupStateSchema,
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal("request"),
    type: z.literal("setup.check"),
    payload: SetupCheckSchema,
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal("request"),
    type: z.literal("setup.install"),
    payload: SetupInstallSchema,
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal("request"),
    type: z.literal("setup.signin"),
    payload: SetupSigninSchema,
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal("request"),
    type: z.literal("setup.signin.cancel"),
    payload: SetupSigninCancelSchema,
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal("event"),
    type: z.literal("setup.signin.progress"),
    payload: SetupSigninProgressSchema,
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal("request"),
    type: z.literal("view.subscribe"),
    payload: ViewSubscribeSchema,
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal("request"),
    type: z.literal("view.acknowledge"),
    payload: ViewAcknowledgeSchema,
  }),
]);
export type WatchMessage = z.infer<typeof WatchMessageSchema>;
export type SweepStatus = z.infer<typeof SweepStatusSchema>;
export type SweepSourceState = z.infer<typeof SweepSourceStateSchema>;
export type SweepSourceProgress = z.infer<typeof SweepSourceProgressSchema>;
export type SweepProgress = z.infer<typeof SweepProgressSchema>;
