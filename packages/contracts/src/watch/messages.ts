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
/** Reasons are plain text the host chose for display, never command output; the window branches on code. */
export const SWEEP_REASON_MAX_LENGTH = 200;
export const SweepReasonSchema = z.string().min(1).max(SWEEP_REASON_MAX_LENGTH);
/**
 * Why a source or sweep stopped short. signin: a tool is not signed in or lacks access; budget: put
 * off for the GraphQL budget floor; throttled: GitHub asked for a pause; cadence: not due this sweep;
 * limit: a read was cut at a page or size limit; unavailable: the forge answered with a server error;
 * timeout: a command ran out of time; save: the snapshot could not be committed.
 */
export const SweepReasonCodeSchema = z.enum([
  "signin",
  "budget",
  "throttled",
  "cadence",
  "limit",
  "unavailable",
  "timeout",
  "save",
  "other",
]);
export const SweepSourceStateSchema = z.enum([
  "waiting",
  "reading",
  "throttled",
  "read",
  "cut",
  "deferred",
  "skipped",
  "failed",
]);
const sourceBase = { source: IdentifierSchema, startedAt: ObservedAtSchema.optional() };
const ended = { ...sourceBase, endedAt: ObservedAtSchema.optional() };
const reasoned = { code: SweepReasonCodeSchema, reason: SweepReasonSchema };
const mayReason = { code: SweepReasonCodeSchema.optional(), reason: SweepReasonSchema.optional() };
// throttled pauses a read within this sweep and resumes at resumeAt; deferred leaves the source
// unread this sweep, and resumeAt, when known, is when its budget allows a read again.
export const SweepSourceProgressSchema = z
  .discriminatedUnion("state", [
    z.strictObject({ source: IdentifierSchema, state: z.literal("waiting") }),
    z.strictObject({
      source: IdentifierSchema,
      state: z.literal("reading"),
      startedAt: ObservedAtSchema,
    }),
    z.strictObject({
      ...sourceBase,
      state: z.literal("throttled"),
      ...reasoned,
      resumeAt: ObservedAtSchema,
    }),
    z.strictObject({ ...ended, state: z.literal("read") }),
    z.strictObject({
      ...ended,
      state: z.literal("cut"),
      ...mayReason,
      incomplete: z
        .strictObject({ count: z.int().positive(), total: z.int().positive() })
        .refine(({ count, total }) => count <= total, {
          message: "Incomplete count exceeds total",
        }),
    }),
    z.strictObject({
      ...ended,
      state: z.literal("deferred"),
      ...reasoned,
      resumeAt: ObservedAtSchema.optional(),
    }),
    z.strictObject({ ...ended, state: z.literal("skipped"), ...mayReason }),
    z.strictObject({ ...ended, state: z.literal("failed"), ...reasoned }),
  ])
  .refine((source) => !("reason" in source) || "code" in source, {
    message: "A reason needs its code",
    path: ["code"],
  })
  .refine((source) => !("code" in source) || "reason" in source, {
    message: "A code needs its reason",
    path: ["reason"],
  })
  .refine(
    (source) =>
      !("endedAt" in source && source.endedAt && source.startedAt) ||
      Date.parse(source.endedAt) >= Date.parse(source.startedAt),
    { message: "A source cannot end before it starts", path: ["endedAt"] },
  );
const sweepProgress = {
  sweep: IdentifierSchema,
  startedAt: ObservedAtSchema,
  first: z.boolean(),
  usualMs: z.int().positive().nullable(),
  sources: z.array(SweepSourceProgressSchema),
};
// The whole current state of one sweep, so a late subscriber needs no history. nextAttemptAt is the
// retry the host has scheduled after a failure, not the GraphQL budget reset in sweep.status. A
// failed sweep names the source it was reading when it stopped, and no source when saving failed.
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
      code: SweepReasonCodeSchema,
      failure: SweepReasonSchema,
      source: IdentifierSchema.optional(),
      nextAttemptAt: ObservedAtSchema.nullable(),
    }),
  ])
  .refine(({ sources }) => new Set(sources.map(({ source }) => source)).size === sources.length, {
    message: "Each source appears once",
    path: ["sources"],
  })
  .refine(
    (progress) =>
      progress.outcome !== "failed" ||
      progress.source === undefined ||
      progress.sources.some(({ source }) => source === progress.source),
    { message: "The failed source must be one of the sweep's sources", path: ["source"] },
  );
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
export type SweepReasonCode = z.infer<typeof SweepReasonCodeSchema>;
export type SweepSourceProgress = z.infer<typeof SweepSourceProgressSchema>;
export type SweepProgress = z.infer<typeof SweepProgressSchema>;
