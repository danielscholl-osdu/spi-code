// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { IdentifierSchema, ObservedAtSchema } from "./evidence.js";
import { ItemClassSchema } from "./inspect.js";
import { BriefFactSchema, RepositoriesSchema, ToneSchema, UpstreamViewSchema } from "./panes.js";

export { type BriefFact, BriefFactSchema, type Tone, ToneSchema } from "./panes.js";

export const LinkSchema = z.strictObject({ label: z.string(), url: z.string() });
export const FocusItemSchema = z.strictObject({
  id: z.string(),
  ids: z.array(z.string()),
  rung: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  cls: ItemClassSchema,
  scope: z.string(),
  title: z.string(),
  sub: z.string(),
  cause: z.string(),
  effect: z.string(),
  next: z.string(),
  verb: z.string(),
  evidence: z.array(LinkSchema),
  more: z.array(z.strictObject({ label: z.string(), text: z.string() })).optional(),
});
export const ReadyLineSchema = z.strictObject({
  id: z.string(),
  text: z.string(),
  count: z.int().nonnegative(),
});
export const ThemeForkSchema = z.strictObject({
  fork: z.string(),
  state: z.string(),
  url: z.string().optional(),
  inspect: z.string().optional(),
});
export const ThemeKindSchema = z.enum(["halt", "toolchain", "port", "rollout", "deadline"]);
export const ThemeSchema = z.strictObject({
  id: z.string(),
  kind: ThemeKindSchema,
  title: z.string(),
  sub: z.string(),
  certain: z.array(ThemeForkSchema),
  possible: z.array(ThemeForkSchema),
  exposed: z.array(z.string()),
  when: z.string().optional(),
  tone: ToneSchema,
  next: z.string(),
  inspect: z.string().optional(),
});
export const DoctorViewSchema = z.strictObject({
  state: z.enum(["dark", "partial", "clear", "waiting"]),
  problems: z.array(z.string()),
});
export const EnvStateSchema = z.enum(["ok", "failed", "cancelled", "running", "held"]);
export const EnvEventSchema = z.strictObject({
  id: z.string(),
  start: ObservedAtSchema,
  end: ObservedAtSchema.optional(),
  state: EnvStateSchema,
  label: z.string(),
  detail: z.string(),
  inspect: z.string().optional(),
});
export const EnvLaneSchema = z.strictObject({
  id: z.enum(["upgrade", "refresh", "smoke", "holds"]),
  label: z.string(),
  events: z.array(EnvEventSchema),
});
export const EnvironmentSchema = z.strictObject({
  headline: z.string(),
  facts: z.array(BriefFactSchema),
  lanes: z.array(EnvLaneSchema),
  from: ObservedAtSchema,
  to: ObservedAtSchema,
  note: z.string().optional(),
});
export const BriefingSchema = z.strictObject({
  sweptAt: ObservedAtSchema.optional(),
  nextSyncAt: ObservedAtSchema.optional(),
  doctor: DoctorViewSchema,
  headline: z.string(),
  summary: z.string(),
  facts: z.array(BriefFactSchema),
  focus: z.array(FocusItemSchema),
  more: z.int().nonnegative(),
  rest: z.array(FocusItemSchema),
  ready: z.array(ReadyLineSchema),
  themes: z.array(ThemeSchema),
  horizon: z.strictObject({ headline: z.string() }),
  flow: UpstreamViewSchema,
  environment: EnvironmentSchema,
  repositories: RepositoriesSchema,
});
export const ItemAttentionSchema = z.strictObject({
  attention: z.enum(["interrupt", "surface", "ambient"]),
  due: z.strictObject({ at: ObservedAtSchema, before: IdentifierSchema }).optional(),
  owned: z.boolean(),
});
export const WatchItemSchema = FocusItemSchema.extend(ItemAttentionSchema.shape);
export const WatchBriefingSchema = BriefingSchema.extend({
  focus: z.array(WatchItemSchema),
  rest: z.array(WatchItemSchema),
});

export type WatchItem = z.infer<typeof WatchItemSchema>;
export type WatchBriefing = z.infer<typeof WatchBriefingSchema>;
export type ItemAttention = z.infer<typeof ItemAttentionSchema>;
export type Link = z.infer<typeof LinkSchema>;
export type FocusItem = z.infer<typeof FocusItemSchema>;
export type ReadyLine = z.infer<typeof ReadyLineSchema>;
export type ThemeFork = z.infer<typeof ThemeForkSchema>;
export type ThemeKind = z.infer<typeof ThemeKindSchema>;
export type Theme = z.infer<typeof ThemeSchema>;
export type DoctorView = z.infer<typeof DoctorViewSchema>;
export type EnvState = z.infer<typeof EnvStateSchema>;
export type EnvEvent = z.infer<typeof EnvEventSchema>;
export type EnvLane = z.infer<typeof EnvLaneSchema>;
export type Environment = z.infer<typeof EnvironmentSchema>;
export type Briefing = z.infer<typeof BriefingSchema>;
