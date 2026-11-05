// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { IdentifierSchema, ObservedAtSchema } from "./evidence.js";
import { InspectRequestSchema, InspectResultSchema } from "./inspect.js";
import {
  SetupInstallSchema,
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
    type: z.literal("setup.state"),
    payload: SetupStateSchema,
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
]);
export type WatchMessage = z.infer<typeof WatchMessageSchema>;
export type SweepStatus = z.infer<typeof SweepStatusSchema>;
