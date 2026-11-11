// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { AttentionTier } from "../attention.js";
import type { Model } from "../model/index.js";
import type { QueueItem } from "../model/queue.js";
import { names, plural } from "../util.js";
import { type HorizonStages, horizonStages, itemOrigin, type Origin, upstreamHorizon } from "./horizon.js";
import type { Theme, ThemeKind } from "./index.js";

export type HorizonStage = "upstream" | "queued" | "held" | "wont-land" | "landed" | "unknown";
export type CardMark = "stopped" | "needs-person";

export interface PrRef {
  number: number;
  url?: string;
  inspect?: string;
}

export interface HorizonCardService {
  service: string;
  stage: HorizonStage;
  pr?: PrRef;
  at?: string;
}

export interface HorizonCard {
  id: string;
  kind: ThemeKind | "sync";
  token: string;
  services: HorizonCardService[];
  needsYou: boolean;
  mark?: CardMark;
  verb?: string;
  itemIds: string[];
  text: string;
}

export interface HorizonCounts {
  needYouCards: number;
  toWatchCards: number;
  surfaceItems: number;
  text: string;
}

export interface DecisionGroup {
  id: string;
  theme: string;
  kind?: ThemeKind;
  token?: string;
  scope: { service: string; pr?: PrRef }[];
  itemIds: string[];
  verb?: string;
  text: string;
}

export interface Decisions {
  items: number;
  text: string;
  groups: DecisionGroup[];
}

/** A briefing item once the host has set its tier. */
export interface TieredItem {
  id: string;
  ids: readonly string[];
  attention: AttentionTier;
  origin?: Origin | undefined;
  title: string;
  verb: string;
}

export interface HorizonCardsInput {
  model: Model;
  items: readonly TieredItem[];
  themes: readonly Theme[];
  /** Forks whose radar read was cut or failed, so a change could be missing from them. */
  unread?: readonly string[];
}

function fact(item: QueueItem, label: string): string | undefined {
  return item.cause.find((f) => f.label === label)?.value;
}

// The change an upstream item is about: the lead value or halt entry its own title names.
function changeOf(item: QueueItem): { kind: "halt" | "toolchain"; token: string } | undefined {
  if (item.kind !== "radar" && item.kind !== "halt") return undefined;
  const entry = item.halt?.entries[0];
  if (entry) return { kind: "halt", token: entry };
  const value = fact(item, "value");
  return item.kind === "radar" && value ? { kind: "toolchain", token: value } : undefined;
}

function cardOf(theme: Theme, item: QueueItem): boolean {
  const change = changeOf(item);
  return (
    change !== undefined &&
    theme.kind === change.kind &&
    theme.title === change.token &&
    theme.certain.some((f) => f.fork === item.scope)
  );
}

// One reading of where the fork stands: the horizon's own stages, so a card and the conveyor agree.
function stageOf(stages: HorizonStages, model: Model, service: string): HorizonCardService {
  const fork = model.upstream.forks.find((f) => f.service === service);
  if (fork?.behind === undefined) return { service, stage: "unknown" };
  if (stages.wontLand.some((f) => f.service === service)) return { service, stage: "wont-land" };
  const held = stages.held.prs.find((p) => p.service === service);
  const queued = stages.nextSync.services.includes(service);
  if (held && !queued) return { service, stage: "held", pr: held.pr };
  if (queued && !held) {
    return { service, stage: "queued", ...(stages.nextSync.at ? { at: stages.nextSync.at } : {}) };
  }
  return { service, stage: "unknown" };
}

function verbOf(kind: HorizonCard["kind"], token: string): string {
  return kind === "sync" ? "Review" : kind === "halt" ? "Pre-classify" : token.startsWith("Java ") ? "Move pin" : "Absorb";
}

const STAGE_WORDS: Readonly<Record<HorizonStage, string>> = Object.freeze({
  held: "in sync PRs on",
  queued: "at the next sync on",
  "wont-land": "won't land on",
  upstream: "in open upstream MRs for",
  landed: "landed on",
  unknown: "stage not proven on",
});

function cardText(
  card: { kind: HorizonCard["kind"]; token: string; map?: string | undefined },
  services: readonly HorizonCardService[],
  needsYou: boolean,
  missing: readonly string[],
): string {
  const parts = (Object.keys(STAGE_WORDS) as HorizonStage[]).flatMap((stage) => {
    const forks = services.filter((s) => s.stage === stage).map((s) => s.service);
    return forks.length > 0 ? [`${STAGE_WORDS[stage]} ${names(forks)}`] : [];
  });
  const where = `${card.token}: ${parts.join("; ") || "no fork named"}.`;
  const unread = missing.length > 0 ? ` Not fully read on ${names(missing)}.` : "";
  if (!needsYou) return `${where}${unread}`;
  const act =
    card.kind === "sync"
      ? `Review${services[0]?.pr ? ` PR #${services[0].pr.number}` : " the sync PR"}.`
      : card.kind === "halt"
      ? `Add it to ${card.map ?? "the filter"} first.`
      : card.token.startsWith("Java ")
        ? "Move the pin."
        : services.every((s) => s.stage === "held")
          ? "Absorb it before merging."
          : "Absorb it on the fork first.";
  return `${where} ${act}${unread}`;
}

/** Upstream change cards and unjoined PRs, from items whose tier the host has set. */
export function horizonCards(input: HorizonCardsInput): {
  cards: HorizonCard[];
  counts: HorizonCounts;
  owed: ReturnType<typeof upstreamHorizon>["owed"] & { itemIds: string[] };
} {
  const { model, items, themes } = input;
  const stages = horizonStages(model);
  const tierOf = new Map(items.map((item) => [item.id, item.attention]));
  const upstream = model.queue.items.filter(
    (q) => tierOf.has(q.id) && itemOrigin(q) === "upstream" && changeOf(q) !== undefined,
  );
  const placed = new Set<string>();
  const built: { card: Omit<HorizonCard, "text" | "needsYou">; map?: string | undefined }[] = [];
  const add = (
    kind: ThemeKind,
    token: string,
    id: string,
    certain: readonly string[],
    possible: readonly string[],
    members: readonly QueueItem[],
    map?: string,
  ) => {
    for (const member of members) placed.add(member.id);
    built.push({
      card: {
        id,
        kind,
        token,
        services: [
          ...certain.map((fork) => stageOf(stages, model, fork)),
          ...possible.map((service) => ({ service, stage: "upstream" as const })),
        ],
        itemIds: members.map((member) => member.id),
      },
      map,
    });
  };
  for (const theme of themes) {
    if (theme.kind !== "halt" && theme.kind !== "toolchain") continue;
    const members = upstream.filter((q) => !placed.has(q.id) && cardOf(theme, q));
    add(
      theme.kind,
      theme.title,
      theme.id,
      theme.certain.map((f) => f.fork),
      theme.possible.map((f) => f.fork),
      members,
      theme.kind === "halt" ? theme.id.split(":")[1] : undefined,
    );
  }
  // An item no theme names still has one home: a card of its own.
  for (const q of upstream) {
    const change = changeOf(q);
    if (placed.has(q.id) || !change) continue;
    add(change.kind, change.token, `${change.kind}:${change.token}:${q.scope}`, [q.scope], [], [q]);
  }
  // A sync PR proven to hold a change joins one card, preferably the one with its fork's own item.
  const scopeOf = new Map(upstream.map((q) => [q.id, q.scope]));
  for (const fork of model.upstream.forks) {
    if (!fork.syncPr || !fork.behind || fork.syncPr.holds !== fork.behind) continue;
    const gate = model.queue.items.find((q) =>
      q.kind === "gate1" && q.scope === fork.service && q.url === fork.syncPr?.url);
    if (!gate || !tierOf.has(gate.id) || placed.has(gate.id)) continue;
    const holding = built.filter(({ card }) =>
      card.services.some((s) => s.service === fork.service && (s.stage === "held" || s.stage === "wont-land")));
    const home =
      holding.find(({ card }) => card.itemIds.some((m) => scopeOf.get(m) === fork.service)) ??
      holding[0];
    if (!home) continue;
    home.card.itemIds.push(gate.id);
    const service = home.card.services.find((s) => s.service === fork.service);
    if (service) service.pr = {
      number: fork.syncPr.number, url: fork.syncPr.url, inspect: gate.id,
    };
    placed.add(gate.id);
  }
  for (const q of model.queue.items) {
    const tier = tierOf.get(q.id);
    if (q.kind !== "gate1" || placed.has(q.id) || (tier !== "surface" && tier !== "interrupt")) continue;
    const pr = prOf(q.url, q.id);
    built.push({
      card: {
        id: `sync:${q.id}`,
        kind: "sync",
        token: "Sync upstream",
        services: [{ service: q.scope, stage: "unknown", ...(pr ? { pr } : {}) }],
        itemIds: [q.id],
      },
    });
    placed.add(q.id);
  }
  const unread = new Set([
    ...(input.unread ?? []),
    ...model.upstream.forks.filter((f) => f.behind === undefined).map((f) => f.service),
    ...Object.entries(model.radar.services)
      .filter(([, svc]) => svc.state === "unmeasured")
      .map(([service]) => service),
  ]);
  let surfaceItems = 0;
  let partial = false;
  const cards = built.map(({ card, map }): HorizonCard => {
    const tiers = card.itemIds.map((id) => tierOf.get(id));
    const surface = tiers.filter((tier) => tier === "surface").length;
    surfaceItems += surface;
    const interrupt = tiers.includes("interrupt");
    const needsYou = interrupt || surface > 0;
    const missing = card.services
      .filter((s) => s.stage === "unknown" || unread.has(s.service))
      .map((s) => s.service);
    if (missing.length > 0) partial = true;
    return {
      ...card,
      needsYou,
      ...(interrupt ? { mark: "stopped" } : surface > 0 ? { mark: "needs-person" } : {}),
      ...(needsYou ? { verb: verbOf(card.kind, card.token) } : {}),
      text: cardText({ kind: card.kind, token: card.token, map }, card.services, needsYou, missing),
    };
  });
  const ordered = [...cards.filter((c) => c.needsYou), ...cards.filter((c) => !c.needsYou)];
  const needYou = ordered.filter((c) => c.needsYou).length;
  const toWatch = ordered.length - needYou;
  const watch = toWatch > 0 ? ` · ${toWatch} to watch` : "";
  const behindUnread = model.upstream.forks.filter(
    (f) => unread.has(f.service) && (f.behind === undefined || f.behind > 0),
  ).length;
  const text =
    needYou > 0
      ? `${needYou} ${needYou === 1 ? "needs you before it lands" : "need you before they land"}${watch}`
      : behindUnread > 0 || partial
        ? `Nothing read needs you before it lands${watch} · ${plural(Math.max(behindUnread, 1), "fork")} not fully read`
        : `Nothing needs you before it lands${watch}`;
  return {
    cards: ordered,
    counts: { needYouCards: needYou, toWatchCards: toWatch, surfaceItems, text },
    owed: {
      ...upstreamHorizon(model).owed,
      itemIds: items.filter((item) => model.queue.items.some((q) =>
        q.kind === "port" && (q.id === item.id || item.ids.includes(q.id)))).map((item) => item.id),
    },
  };
}

function prOf(url: string | undefined, inspect?: string): PrRef | undefined {
  const number = /\/pull\/(\d+)(?:$|[/?#])/.exec(url ?? "")?.[1];
  return number && url
    ? { number: Number(number), url, ...(inspect ? { inspect } : {}) }
    : undefined;
}

/** The in-system Surface items, grouped once per core theme; an item no theme names is its own group. */
export function briefingDecisions(
  model: Model,
  items: readonly TieredItem[],
  themes: readonly Theme[],
): Decisions {
  const forks = new Set(model.lines.map((line) => line.fork.id));
  const queue = new Map(model.queue.items.map((q) => [q.id, q]));
  const groups = new Map<string, DecisionGroup>();
  for (const item of items) {
    const q = queue.get(item.id);
    const origin = item.origin ?? (q ? itemOrigin(q) : undefined);
    if (item.attention !== "surface" || origin !== "system") continue;
    const theme = themes.find(
      (t) =>
        (t.inspect !== undefined && item.ids.includes(t.inspect)) ||
        (t.kind === "rollout" && (q?.kind === "rollout" || q?.kind === "template-set")),
    );
    const key = theme?.id ?? item.id;
    const group = groups.get(key);
    if (group) {
      group.itemIds.push(item.id);
      group.text = `${theme?.title ?? item.title} · ${plural(group.itemIds.length, "item")}`;
      continue;
    }
    const scope = theme
      ? theme.certain.map((f) => {
          const pr = prOf(f.url, f.inspect);
          return { service: f.fork, ...(pr ? { pr } : {}) };
        })
      : (q?.scope ?? "")
          .split(/,\s*/)
          .filter((service) => forks.has(service))
          .map((service) => {
            const pr = prOf(q?.url, item.id);
            return { service, ...(pr ? { pr } : {}) };
          });
    groups.set(key, {
      id: `decision:${key}`,
      theme: key,
      ...(theme ? { kind: theme.kind, token: theme.title } : {}),
      scope,
      itemIds: [item.id],
      ...(item.verb ? { verb: item.verb } : {}),
      text: item.title,
    });
  }
  const list = [...groups.values()];
  const count = list.reduce((sum, g) => sum + g.itemIds.length, 0);
  return {
    items: count,
    text:
      count === 0
        ? "Nothing in the system waits on a decision."
        : `${count} in ${plural(list.length, "theme")}`,
    groups: list,
  };
}
