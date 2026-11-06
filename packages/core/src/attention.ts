// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { SYNC_UPSTREAM_CRON } from "./config.js";
import type { Model } from "./model/index.js";
import type { QueueItem } from "./model/queue.js";
import { nextFire, toCrons } from "./model/schedule.js";

// How loud a state is. Core decides it; the window only renders it.
export type AttentionTier = "interrupt" | "surface" | "ambient";

// The state of the thread that owns an item.
export type OwnerState = "working" | "waiting" | "done" | "failed" | "stalled" | "lost";

// How long before its due time an unowned item interrupts.
export const LEAD_TIME_MS = 2 * 60 * 60 * 1000;

export const BEFORE_NEXT_SYNC = "next sync";

export interface Due {
  at: string;
  before: string;
}

export interface AttentionSubject {
  id: string;
  ids: readonly string[];
  rung: number;
}

export interface PriorAttention extends AttentionSubject {
  attention: AttentionTier;
  owned: boolean;
}

export interface AttentionOptions {
  now: Date;
  leadTimeMs: number;
  // The items as last projected; an item absent from them is new.
  previous?: readonly PriorAttention[];
  themes?: readonly { id: string; inspect?: string }[];
  // Theme ids already detected; absent means every theme is new.
  previousThemes?: readonly string[];
  // Owning threads by item id.
  owners?: ReadonlyMap<string, OwnerState>;
  // Item ids with a card waiting on a decision.
  cards?: ReadonlySet<string>;
}

export interface Attention {
  attention: AttentionTier;
  owned: boolean;
  due?: Due;
}

const OWNER_FAILED: ReadonlySet<OwnerState> = new Set(["failed", "stalled", "lost"]);

function idsOf(item: { id: string; ids?: readonly string[] }): string[] {
  return [item.id, ...(item.ids ?? [])];
}

function queueItemsOf(item: AttentionSubject, model: Model): QueueItem[] {
  const ids = new Set(idsOf(item));
  return model.queue.items.filter((q) => ids.has(q.id));
}

export function nextSyncAt(now: Date): string | undefined {
  const at = nextFire(toCrons([SYNC_UPSTREAM_CRON]), now);
  return at === undefined ? undefined : new Date(at).toISOString();
}

// Queued upstream commits reach the fork at the next sync, so what they carry is due before it.
export function dueOf(items: readonly QueueItem[], now: Date): Due | undefined {
  if (!items.some((q) => q.kind === "radar")) return undefined;
  const at = nextSyncAt(now);
  return at ? { at, before: BEFORE_NEXT_SYNC } : undefined;
}

// A recovery that already ran and failed again: the line stops on it.
function failedRecovery(items: readonly QueueItem[]): boolean {
  return items.some((q) => q.judgement?.response === "stop" && q.judgement.cause !== undefined);
}

function ownerOf(
  ids: readonly string[],
  owners: ReadonlyMap<string, OwnerState> | undefined,
): OwnerState | undefined {
  const states = ids.flatMap((id) => {
    const s = owners?.get(id);
    return s ? [s] : [];
  });
  return (
    states.find((s) => OWNER_FAILED.has(s)) ??
    states.find((s) => s !== "done") ??
    states.find((s) => s === "done")
  );
}

function priorOf(
  item: AttentionSubject,
  previous: readonly PriorAttention[],
): PriorAttention | undefined {
  const ids = new Set(idsOf(item));
  return (
    previous.find((p) => p.id === item.id) ?? previous.find((p) => idsOf(p).some((id) => ids.has(id)))
  );
}

export function attentionOf(item: AttentionSubject, model: Model, opts: AttentionOptions): Attention {
  const ids = idsOf(item);
  const queued = queueItemsOf(item, model);
  const due = dueOf(queued, opts.now);
  const owner = ownerOf(ids, opts.owners);
  const owned = owner !== undefined;
  const prior = priorOf(item, opts.previous ?? []);
  const worsened = prior !== undefined && item.rung < prior.rung;
  const withinLead =
    due !== undefined && Date.parse(due.at) - opts.now.getTime() <= opts.leadTimeMs;
  const newTheme = (opts.themes ?? []).some(
    (t) =>
      t.inspect !== undefined &&
      ids.includes(t.inspect) &&
      !(opts.previousThemes ?? []).includes(t.id),
  );

  const interrupt =
    ids.some((id) => opts.cards?.has(id)) ||
    failedRecovery(queued) ||
    (owned
      ? (owner !== undefined && OWNER_FAILED.has(owner)) ||
        worsened ||
        (prior?.owned === true && prior.attention === "interrupt")
      : item.rung === 0 || withinLead);
  const surface =
    owner === "done" ||
    due !== undefined ||
    newTheme ||
    (!owned && item.rung === 1 && prior === undefined);

  const attention: AttentionTier = interrupt ? "interrupt" : surface ? "surface" : "ambient";
  return due ? { attention, owned, due } : { attention, owned };
}

export interface AttentionSource {
  id: string;
  ids?: readonly string[];
  attention: AttentionTier;
}

// The number of distinct things interrupting: sources that share any id are one,
// so a card, the thread waiting on it and the P0 it owns count once.
export function interruptCount(sources: readonly AttentionSource[]): number {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    parent.set(x, root);
    return root;
  };
  const add = (x: string) => {
    if (!parent.has(x)) parent.set(x, x);
  };
  for (const s of sources) {
    const ids = idsOf(s);
    for (const id of ids) add(id);
    for (const id of ids.slice(1)) parent.set(find(id), find(s.id));
  }
  const roots = new Set<string>();
  for (const s of sources) if (s.attention === "interrupt") roots.add(find(s.id));
  return roots.size;
}
