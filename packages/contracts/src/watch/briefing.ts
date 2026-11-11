// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { AreaNameSchema, IdentifierSchema, ObservedAtSchema } from "./evidence.js";
import { ItemClassSchema } from "./inspect.js";
import {
  BriefFactSchema,
  PrRefSchema,
  RepositoriesSchema,
  ToneSchema,
  UpstreamViewSchema,
  unreadSchema,
} from "./panes.js";

export { type BriefFact, BriefFactSchema, type Tone, ToneSchema } from "./panes.js";

/** In the system (forks, PRs, environment, template, releases), or coming from upstream GitLab. */
export const OriginSchema = z.enum(["system", "upstream"]);

export const LinkSchema = z.strictObject({ label: z.string(), url: z.string() });
export const FocusItemSchema = z.strictObject({
  id: z.string(),
  ids: z.array(z.string()),
  origin: OriginSchema.optional(),
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
  /** How long the item has stood, as core words it ("2h"); absent when core cannot date it. */
  age: z.string().optional(),
  /** What waits on the item, as a chip ("blocks 3"); absent when nothing does or core cannot tell. */
  blocks: z.strictObject({ count: z.int().positive(), text: z.string() }).optional(),
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
/** The strip's four marks: stopped or Interrupt, Surface, Ambient, and nothing due or Background. */
export const MarkSchema = z.enum(["stopped", "needs-person", "in-progress", "nothing-due"]);
/** How loud an item is; core decides it once and Today never re-tiers it. */
export const AttentionTierSchema = z.enum(["interrupt", "surface", "ambient", "background"]);
/** One meaning per slot shape; unknown is a run whose effect core cannot prove. */
export const SlotStateSchema = z.enum([
  "empty",
  "occupied",
  "done",
  "waiting",
  "broken",
  "unknown",
]);
export const SlotSchema = z.strictObject({
  service: IdentifierSchema,
  state: SlotStateSchema,
  origin: OriginSchema.optional(),
  text: z.string(),
});
export const VerdictSchema = z.strictObject({ text: IdentifierSchema, mark: MarkSchema });
export const SinceRowSchema = z.strictObject({
  workflow: IdentifierSchema,
  label: z.string(),
  countText: z.string(),
  slots: z.array(SlotSchema),
});
/** seen: since the last look; fallback: 24 hours; history-short: from the oldest run read; stale: as of. */
export const SinceSchema = z
  .strictObject({
    basis: z.enum(["seen", "fallback", "history-short", "stale"]),
    from: ObservedAtSchema,
    rows: z.array(SinceRowSchema),
    asOf: ObservedAtSchema.optional(),
  })
  .refine(({ basis, asOf }) => (basis === "stale") === (asOf !== undefined), {
    message: "Only stale since rows require an as-of time",
    path: ["asOf"],
  });
const PLACES = ["line", "environment", "engineering", "security"] as const;
export const PlaceIdSchema = z.enum(PLACES);
export const LifecycleLaneSchema = z.strictObject({
  lane: z.enum(["refresh", "upgrade", "smoke", "sweeper"]),
  /** Unknown when no completed run in the 21-day window proves a pass rate. */
  state: z.enum(["read", "unknown"]).optional(),
  green: z.int().nonnegative(),
  total: z.int().nonnegative(),
  text: z.string(),
});
export const PlaceVisualSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("pips"),
    slots: z.array(SlotSchema),
    stopped: z.array(IdentifierSchema),
    horizon: z.strictObject({ count: z.int().positive(), text: z.string() }).optional(),
  }),
  z.strictObject({
    kind: z.literal("lifecycle"),
    lanes: z.array(
      LifecycleLaneSchema.refine(({ green, total }) => green <= total, {
        message: "Green runs exceed the total",
      }),
    ),
    greenSince: ObservedAtSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("rollout"),
    target: IdentifierSchema,
    slots: z.array(SlotSchema),
  }),
  z.strictObject({
    kind: z.literal("forkColumns"),
    columns: z.array(
      z.strictObject({
        service: IdentifierSchema,
        count: z.int().nonnegative().nullable(),
        rules: z.array(z.string()),
        text: z.string(),
      }),
    ),
    program: z
      .strictObject({
        count: z.int().nonnegative().nullable(),
        rules: z.array(z.string()),
        text: z.string(),
      })
      .optional(),
    largest: z
      .strictObject({ label: z.string(), forks: z.int().positive(), text: z.string() })
      .optional(),
  }),
]);
const VISUAL_OF: Readonly<Record<(typeof PLACES)[number], string>> = {
  line: "pips",
  environment: "lifecycle",
  engineering: "rollout",
  security: "forkColumns",
};
export const PlaceRowSchema = z
  .strictObject({
    place: PlaceIdSchema,
    mark: MarkSchema,
    tone: ToneSchema,
    figure: z.string(),
    line: z.string(),
    reason: z.string().optional(),
    caveat: z.string().optional(),
    areas: z.array(AreaNameSchema),
    unread: unreadSchema(AreaNameSchema).optional(),
    /** Ids of the items the figure counts, of any tier; a Background item counted here has its home. */
    itemIds: z.array(IdentifierSchema),
    /** Ids of the place's items, of any tier, new since the last look; empty is not fresh. */
    fresh: z.strictObject({ itemIds: z.array(IdentifierSchema) }),
    visual: PlaceVisualSchema.optional(),
  })
  .refine(({ place, visual }) => !visual || visual.kind === VISUAL_OF[place], {
    message: "The visual is not this place's",
    path: ["visual", "kind"],
  });
/** Where a fork stands with an upstream change; unknown when core cannot prove which stage holds it. */
export const HorizonStageSchema = z.enum([
  "upstream",
  "queued",
  "held",
  "wont-land",
  "landed",
  "unknown",
]);
export const HorizonCardSchema = z.strictObject({
  id: IdentifierSchema,
  kind: ThemeKindSchema.or(z.literal("sync")),
  token: IdentifierSchema,
  services: z.array(
    z.strictObject({
      service: IdentifierSchema,
      stage: HorizonStageSchema,
      pr: PrRefSchema.optional(),
      at: ObservedAtSchema.optional(),
    }),
  ),
  needsYou: z.boolean(),
  mark: MarkSchema.optional(),
  verb: z.string().optional(),
  itemIds: z.array(IdentifierSchema),
  text: z.string(),
});
const total = (counts: readonly number[]) => counts.reduce((sum, count) => sum + count, 0);
const forkCount = z.strictObject({ service: IdentifierSchema, count: z.int().positive() });
export const HorizonSchema = z.strictObject({
  headline: z.string(),
  stages: z
    .strictObject({
      upstream: z.strictObject({ count: z.int().nonnegative(), text: z.string() }),
      nextSync: z.strictObject({
        at: ObservedAtSchema.optional(),
        count: z.int().nonnegative(),
        services: z.array(IdentifierSchema),
        text: z.string(),
      }),
      held: z.strictObject({
        count: z.int().nonnegative(),
        prs: z.array(z.strictObject({ service: IdentifierSchema, pr: PrRefSchema })),
        services: z.array(IdentifierSchema),
        text: z.string(),
      }),
      forks: z.strictObject({ services: z.array(IdentifierSchema), text: z.string() }),
      wontLand: z.array(
        z.strictObject({
          service: IdentifierSchema,
          reason: z.enum(["stopped", "halted"]),
          count: z.int().nonnegative(),
          text: z.string(),
        }),
      ),
    })
    .optional(),
  cards: z.array(HorizonCardSchema).optional(),
  counts: z
    .strictObject({
      needYouCards: z.int().nonnegative(),
      toWatchCards: z.int().nonnegative(),
      surfaceItems: z.int().nonnegative(),
      text: z.string(),
    })
    .optional(),
  owed: z
    .strictObject({
      itemIds: z.array(IdentifierSchema).optional(),
      count: z.int().nonnegative(),
      services: z.array(forkCount),
      text: z.string(),
    })
    .refine(({ count, services }) => total(services.map((fork) => fork.count)) === count, {
      message: "Ports owed per fork do not sum to the count",
      path: ["count"],
    })
    .optional(),
});
const itemIds = z.array(IdentifierSchema).min(1);
export const DecisionGroupSchema = z.strictObject({
  id: IdentifierSchema,
  theme: IdentifierSchema,
  kind: ThemeKindSchema.optional(),
  token: z.string().optional(),
  scope: z.array(z.strictObject({ service: IdentifierSchema, pr: PrRefSchema.optional() })),
  itemIds,
  verb: z.string().optional(),
  text: z.string(),
});
export const DecisionsSchema = z
  .strictObject({
    items: z.int().nonnegative(),
    text: z.string(),
    groups: z.array(DecisionGroupSchema),
  })
  .refine(({ items, groups }) => total(groups.map((group) => group.itemIds.length)) === items, {
    message: "Groups do not hold the item count",
    path: ["items"],
  });
/** The four stations an item row's line glyph draws: sync PR, release/upstream PR, main, release. */
export const LineStationSchema = z.enum(["sync", "cascade", "main", "release"]);
export const AmbientLineSchema = z
  .strictObject({
    id: IdentifierSchema,
    itemIds,
    count: z.int().positive(),
    service: IdentifierSchema.optional(),
    station: LineStationSchema.optional(),
    pr: PrRefSchema.optional(),
    state: z.strictObject({ text: IdentifierSchema, tone: ToneSchema }).optional(),
    followUp: z.string().optional(),
    age: z.string().optional(),
    next: z.array(IdentifierSchema).optional(),
    origin: OriginSchema,
    text: z.string(),
  })
  .refine(({ count, itemIds }) => count === itemIds.length, {
    message: "A line's count is its item count",
    path: ["count"],
  });
export const AmbientRunSchema = z
  .strictObject({
    items: z.int().nonnegative(),
    text: z.string(),
    lines: z.array(AmbientLineSchema),
  })
  .refine(({ items, lines }) => total(lines.map((line) => line.count)) === items, {
    message: "Lines do not hold the item count",
    path: ["items"],
  });
export const AmbientSchema = z.strictObject({
  failing: AmbientRunSchema,
  inProgress: AmbientRunSchema,
});
export const CanWaitSchema = z.strictObject({
  chips: z.array(
    z.strictObject({
      text: IdentifierSchema,
      count: z.int().positive().optional(),
      service: IdentifierSchema.optional(),
    }),
  ),
  items: z.array(
    z.strictObject({
      id: IdentifierSchema,
      itemIds: z.array(IdentifierSchema),
      service: IdentifierSchema.optional(),
      text: z.string(),
      why: IdentifierSchema,
    }),
  ),
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
  horizon: HorizonSchema,
  flow: UpstreamViewSchema,
  environment: EnvironmentSchema,
  repositories: RepositoriesSchema,
  verdict: VerdictSchema.optional(),
  since: SinceSchema.optional(),
  places: z
    .array(PlaceRowSchema)
    .refine(
      (rows) =>
        rows.every(
          ({ place }, index) =>
            index === 0 || PLACES.indexOf(place) > PLACES.indexOf(rows[index - 1]?.place ?? place),
        ),
      { message: "Places repeat or leave sidebar order" },
    )
    .optional(),
  decisions: DecisionsSchema.optional(),
  ambient: AmbientSchema.optional(),
  canWait: CanWaitSchema.optional(),
});
export const ItemAttentionSchema = z.strictObject({
  attention: AttentionTierSchema,
  due: z.strictObject({ at: ObservedAtSchema, before: IdentifierSchema }).optional(),
  owned: z.boolean(),
  origin: OriginSchema.optional(),
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
export type Mark = z.infer<typeof MarkSchema>;
export type AttentionTier = z.infer<typeof AttentionTierSchema>;
export type Origin = z.infer<typeof OriginSchema>;
export type SlotState = z.infer<typeof SlotStateSchema>;
export type Slot = z.infer<typeof SlotSchema>;
export type Verdict = z.infer<typeof VerdictSchema>;
export type SinceRow = z.infer<typeof SinceRowSchema>;
export type Since = z.infer<typeof SinceSchema>;
export type PlaceId = z.infer<typeof PlaceIdSchema>;
export type PlaceVisual = z.infer<typeof PlaceVisualSchema>;
export type PlaceRow = z.infer<typeof PlaceRowSchema>;
export type HorizonStage = z.infer<typeof HorizonStageSchema>;
export type HorizonCard = z.infer<typeof HorizonCardSchema>;
export type Horizon = z.infer<typeof HorizonSchema>;
export type DecisionGroup = z.infer<typeof DecisionGroupSchema>;
export type Decisions = z.infer<typeof DecisionsSchema>;
export type LineStation = z.infer<typeof LineStationSchema>;
export type AmbientLine = z.infer<typeof AmbientLineSchema>;
export type AmbientRun = z.infer<typeof AmbientRunSchema>;
export type Ambient = z.infer<typeof AmbientSchema>;
export type CanWait = z.infer<typeof CanWaitSchema>;
