// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { IdentifierSchema } from "./evidence.js";
import { WebUrlSchema } from "./inspect.js";

export const ToneSchema = z.enum(["bad", "warn", "ok", "neutral"]);
export const BriefFactSchema = z.strictObject({
  label: z.string(),
  figure: z.string(),
  sub: z.string(),
  tone: ToneSchema,
});
export const RepoCellSchema = z.strictObject({
  text: z.string(),
  tone: ToneSchema,
  rest: z.string().optional(),
  fade: z.boolean().optional(),
});
export const RepoLineSchema = z.strictObject({
  id: IdentifierSchema.optional(),
  url: WebUrlSchema.optional(),
  tag: z.string(),
  tone: ToneSchema,
  text: z.string(),
  sub: z.string(),
  upstream: z.boolean().optional(),
});
export const RepoSectionSchema = z.strictObject({
  title: z.string(),
  count: z.string(),
  rest: z.string().optional(),
  lines: z.array(RepoLineSchema),
  weight: z.enum(["minor", "quiet"]).optional(),
});
export const RepoEntrySchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  group: z.enum(["program", "fork"]),
  cells: z.strictObject({
    changes: RepoCellSchema,
    dependabot: RepoCellSchema,
    issues: RepoCellSchema,
    vulnerabilities: RepoCellSchema,
    codeScanning: RepoCellSchema,
  }),
  title: z.string(),
  tone: ToneSchema,
  sub: z.string(),
  sections: z.array(RepoSectionSchema),
  note: z.string().optional(),
});
export const RepositoriesSchema = z.strictObject({
  headline: z.string(),
  facts: z.array(BriefFactSchema),
  rows: z.array(RepoEntrySchema),
  first: z.string().optional(),
});

export const UpToneSchema = z.enum(["bad", "warn", "ok", "neutral", "run"]);
export const UpTextSchema = z.strictObject({ text: z.string(), tone: UpToneSchema });
export const UpTileSchema = z.strictObject({
  label: z.string(),
  value: z.string(),
  sub: z.string(),
  tone: UpToneSchema,
  meter: z.strictObject({ busy: z.number(), cap: z.number() }).optional(),
});
export const UpRowSchema = z.strictObject({
  fork: z.string(),
  inspect: z.string(),
  tag: z.string(),
  behind: z.string(),
  carries: z.string(),
  ready: UpTextSchema,
  plan: UpTextSchema.extend({ kind: z.enum(["pilot", "wave", "held", "none"]) }),
  line: z.array(UpTextSchema),
  next: UpTextSchema.extend({ strong: z.boolean() }),
  detail: z.strictObject({ title: z.string(), lines: z.array(z.string()) }),
});
export const UpstreamViewSchema = z.strictObject({
  mode: z.enum(["planning", "flight", "quiet"]),
  headline: z.string(),
  sub: z.string(),
  tiles: z.array(UpTileSchema),
  rows: z.array(UpRowSchema),
  plan: z.strictObject({
    title: z.string(),
    lines: z.array(z.strictObject({ label: z.string(), text: z.string() })),
    note: z.string(),
    button: z.string(),
  }),
  schedule: z.strictObject({ title: z.string(), text: z.string() }).optional(),
  next: z.strictObject({
    title: z.string(),
    text: z.string(),
    button: z.string(),
    quiet: z.boolean(),
  }),
  also: z.array(z.strictObject({ text: z.string(), inspect: z.string().optional() })),
  inspect: z.string(),
});
export const RolloutWordsSchema = z.strictObject({
  title: z.string(),
  sub: z.string(),
  cause: z.string(),
  effect: z.string(),
  next: z.string(),
  verb: z.string(),
  plan: z.string(),
  watch: z.string(),
  reaches: z.string(),
});

export const NotesStateSchema = z.enum(["approved", "draft", "none", "invalid"]);
export const DocStatSchema = z.strictObject({
  figure: z.string(),
  short: z.string(),
  label: z.string(),
  tone: z.literal("bad").optional(),
  anchor: z.string(),
});
export const DocActionSchema = z.strictObject({
  level: z.enum(["required", "recommended", "info"]),
  title: z.string(),
  body: z.string().optional(),
  owner: z.string().optional(),
  when: z.string().optional(),
  ifSkipped: z.string().optional(),
});
export const LibShareSchema = z.strictObject({
  version: z.string(),
  services: z.array(z.string()),
});
const DocVisualItemsSchema = z.array(
  z.strictObject({ text: z.string(), sub: z.string().optional() }),
);
export const DocVisualSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("coverage"),
    tiles: z.array(z.strictObject({ id: z.string(), version: z.string(), fresh: z.boolean() })),
  }),
  z.strictObject({ kind: z.literal("library"), shares: z.array(LibShareSchema) }),
  z.strictObject({ kind: z.literal("commands"), items: DocVisualItemsSchema }),
  z.strictObject({ kind: z.literal("steps"), items: DocVisualItemsSchema }),
]);
export const DocHighlightSchema = z.strictObject({
  title: z.string(),
  body: z.string().optional(),
  visual: DocVisualSchema.optional(),
});
export const ChangeTypeSchema = z.enum(["breaking", "new", "improved", "fixed", "security"]);
export const DocAreaSchema = z.strictObject({
  area: z.string(),
  items: z.array(z.strictObject({ type: ChangeTypeSchema, text: z.string() })),
});
export const DocChipSchema = z.strictObject({
  id: z.string(),
  from: z.string().optional(),
  to: z.string(),
  platform: z.boolean(),
});
export const DocRowSchema = z.strictObject({
  id: z.string(),
  group: z.enum(["Services", "Platform"]),
  version: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
  releases: z.number().nullable(),
  upstream: z.string().optional(),
  lib: z.string().nullable().optional(),
  java: z.string().nullable().optional(),
  state: z.enum(["released", "unreleased", "unread"]),
  url: z.string().optional(),
});
export const ReleaseLineSchema = z.strictObject({
  id: z.string(),
  month: z.string(),
  name: z.string(),
  open: z.boolean(),
  stateText: z.string(),
  notes: NotesStateSchema,
  headline: z.string(),
  stats: z.array(DocStatSchema),
  keyChanges: z.array(z.string()),
});
export const ReleaseDocSchema = ReleaseLineSchema.extend({
  eyebrow: z.array(z.string()),
  notesError: z.string().optional(),
  headlineWritten: z.boolean(),
  required: z.array(DocActionSchema),
  info: z.array(DocActionSchema),
  highlights: z.array(DocHighlightSchema),
  issues: z.array(
    z.strictObject({
      state: z.enum(["open", "resolved"]),
      title: z.string(),
      body: z.string().optional(),
    }),
  ),
  openIssues: z.number(),
  changelog: z.array(DocAreaSchema),
  computedChangelog: z.boolean(),
  deps: z.number(),
  chips: z.array(DocChipSchema),
  rows: z.array(DocRowSchema),
  unchanged: z.array(z.string()),
  links: z.array(z.strictObject({ label: z.string(), url: z.string() })),
  unread: z.array(z.string()),
  built: z.string(),
});

export type Tone = z.infer<typeof ToneSchema>;
export type BriefFact = z.infer<typeof BriefFactSchema>;
export type RepoCell = z.infer<typeof RepoCellSchema>;
export type RepoLine = z.infer<typeof RepoLineSchema>;
export type RepoSection = z.infer<typeof RepoSectionSchema>;
export type RepoEntry = z.infer<typeof RepoEntrySchema>;
export type Repositories = z.infer<typeof RepositoriesSchema>;
export type UpTone = z.infer<typeof UpToneSchema>;
export type UpText = z.infer<typeof UpTextSchema>;
export type UpTile = z.infer<typeof UpTileSchema>;
export type UpRow = z.infer<typeof UpRowSchema>;
export type UpstreamView = z.infer<typeof UpstreamViewSchema>;
export type RolloutWords = z.infer<typeof RolloutWordsSchema>;
export type NotesState = z.infer<typeof NotesStateSchema>;
export type DocStat = z.infer<typeof DocStatSchema>;
export type DocAction = z.infer<typeof DocActionSchema>;
export type LibShare = z.infer<typeof LibShareSchema>;
export type DocVisual = z.infer<typeof DocVisualSchema>;
export type DocHighlight = z.infer<typeof DocHighlightSchema>;
export type ChangeType = z.infer<typeof ChangeTypeSchema>;
export type DocArea = z.infer<typeof DocAreaSchema>;
export type DocChip = z.infer<typeof DocChipSchema>;
export type DocRow = z.infer<typeof DocRowSchema>;
export type ReleaseLine = z.infer<typeof ReleaseLineSchema>;
export type ReleaseDoc = z.infer<typeof ReleaseDocSchema>;
