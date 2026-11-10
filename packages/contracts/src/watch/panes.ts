// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { IdentifierSchema, ObservedAtSchema } from "./evidence.js";
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
/** A pull request a Today row names: its number, its page, and the Detail id that opens it. */
export const PrRefSchema = z.strictObject({
  number: z.int().positive(),
  url: WebUrlSchema.optional(),
  inspect: IdentifierSchema.optional(),
});
const distinct = (values: readonly string[]) => new Set(values).size === values.length;
/** Sources a block reads that were not read this sweep, and the oldest last good read among them. */
export const unreadSchema = <T extends z.ZodType<string>>(area: T) =>
  z.strictObject({
    areas: z.array(area).min(1).refine(distinct, { message: "Areas repeat" }),
    lastGood: ObservedAtSchema.optional(),
  });
export const ReleaseVersionSchema = z.strictObject({
  service: IdentifierSchema,
  released: IdentifierSchema,
  proposed: IdentifierSchema.optional(),
  pr: PrRefSchema.optional(),
  coreLibAzure: IdentifierSchema.optional(),
  text: z.string(),
});
export const ReleasesTodaySchema = z.strictObject({
  versions: z.array(ReleaseVersionSchema),
  platform: z.strictObject({
    stack: IdentifierSchema.optional(),
    template: z
      .strictObject({
        released: IdentifierSchema,
        proposed: IdentifierSchema.optional(),
        pr: PrRefSchema.optional(),
      })
      .optional(),
    coreLibAzure: z.array(z.strictObject({ version: IdentifierSchema, count: z.int().positive() })),
    text: z.string(),
  }),
  readyLine: z.string().optional(),
  unread: unreadSchema(IdentifierSchema).optional(),
});
/** Release-please changelog kinds; other keeps untyped entries so the kinds sum to the total. */
export const FormingKindSchema = z.enum([
  "breaking",
  "new",
  "improved",
  "fixed",
  "security",
  "other",
]);
export const FormingEntrySchema = z.strictObject({ kind: FormingKindSchema, title: z.string() });
const count = z.int().nonnegative();
const formingPr = {
  pr: PrRefSchema,
  state: z.enum(["read", "not-read"]),
  entries: z.array(FormingEntrySchema),
};
export const FormingPrSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("service"), service: IdentifierSchema, ...formingPr }),
    z.strictObject({ kind: z.literal("template"), ...formingPr }),
  ])
  .refine(({ state, entries }) => state === "read" || entries.length === 0, {
    message: "An unread release PR body has no entries",
    path: ["entries"],
  });
export const FormingSchema = z
  .strictObject({
    state: z.enum(["read", "partial", "not-read"]),
    prs: z.array(FormingPrSchema),
    kinds: z
      .strictObject({
        breaking: count,
        new: count,
        improved: count,
        fixed: count,
        security: count,
        other: count,
      })
      .optional(),
    notable: z.array(
      z.strictObject({
        title: z.string(),
        kind: FormingKindSchema,
        services: z.array(IdentifierSchema),
        pr: PrRefSchema,
        text: z.string(),
      }),
    ),
    text: z.string(),
  })
  .superRefine(({ state, prs, kinds }, ctx) => {
    if (state === "not-read") {
      if (kinds)
        ctx.addIssue({ code: "custom", message: "Unread kinds are not zero", path: ["kinds"] });
      return;
    }
    if (!kinds) {
      ctx.addIssue({
        code: "custom",
        message: "Read release PRs carry their kinds",
        path: ["kinds"],
      });
      return;
    }
    const total = prs.reduce((sum, { entries }) => sum + entries.length, 0);
    const counted = Object.values(kinds).reduce((sum, count) => sum + count, 0);
    if (counted !== total) {
      ctx.addIssue({
        code: "custom",
        message: `Kinds sum to ${counted}, not the ${total} entries read`,
        path: ["kinds"],
      });
    }
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
export type PrRef = z.infer<typeof PrRefSchema>;
export type ReleaseVersion = z.infer<typeof ReleaseVersionSchema>;
export type ReleasesToday = z.infer<typeof ReleasesTodaySchema>;
export type FormingKind = z.infer<typeof FormingKindSchema>;
export type FormingEntry = z.infer<typeof FormingEntrySchema>;
export type FormingPr = z.infer<typeof FormingPrSchema>;
export type Forming = z.infer<typeof FormingSchema>;
