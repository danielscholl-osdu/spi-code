// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Reading, readItem } from "../brief/index.js";
import type { EntryState, ForkEntry } from "../collect/filters.js";
import type { CoreContext } from "../context.js";
import type { ReadRecord } from "../evidence/index.js";
import type { Model } from "../model/index.js";
import { type ItemClass, itemClass, nextText } from "../model/next.js";
import type { ItemKind, QueueItem, Rung } from "../model/queue.js";
import type { CanvasTone as Tone } from "../tone.js";
import { age, names, plural } from "../util.js";

const RUNG_TONE: Readonly<Record<Rung, Tone>> = Object.freeze({ 0: "error", 1: "caution", 2: "info" });

export const KIND_TITLE: Readonly<Record<ItemKind, string>> = Object.freeze({
  stack: "environment not deployable",
  maintenance: "maintenance held",
  lanes: "fork lanes failed on the environment",
  halt: "sync halted",
  "sync-run": "Sync Upstream failed",
  conflict: "cascade conflict",
  cascade: "cascade stopped",
  main: "main red",
  "template-run": "Sync Template failed",
  gate1: "sync PR",
  gate2: "release/upstream PR",
  "template-red": "template-sync PR failing",
  labels: "label configuration",
  approvals: "workflow approval",
  "template-set": "template-sync set",
  "release-red": "release PR failing",
  releases: "release PRs",
  "template-pr": "osdu-spi PR",
  bump: "env bump",
  access: "fork image cannot be pulled",
  radar: "next sync predicted",
  port: "upstream change owed a port",
  security: "critical security alert in SPI code",
  rollout: "template rollout",
});

export interface InspectState {
  selected?: string;
  item?: QueueItem;
  others?: { id: string; entries: ForkEntry[] };
  reading?: string;
}

export interface InspectField {
  label: string;
  value: string;
  href?: string;
}

export interface EntryRow {
  text: string;
  chip?: { label: string; tone: Tone };
  trailing?: string;
  href?: string;
}

export interface ItemInspection extends Reading {
  id: string;
  class: ItemClass;
  status: { label: string; tone: Tone };
  chip: string;
  lede: string;
  nextLinks: InspectField[];
  why: InspectField[];
  evidence: InspectField[];
  effects: QueueItem["effects"];
  sameEntry?: { state: "reading" | "ready"; rows: EntryRow[] };
}

export function inspectTitle(item: QueueItem): string {
  return `${item.scope} · ${KIND_TITLE[item.kind]}`;
}

export function statusOf(item: QueueItem): ItemInspection["status"] {
  return { label: `P${item.rung} · ${itemClass(item)}`, tone: RUNG_TONE[item.rung] };
}

const FACT_LABEL: Readonly<Record<string, string>> = Object.freeze({
  PR: "Pull request",
  check: "Failed check",
  head: "Head",
  held: "Held",
  halt: "Halt code",
  why: "Why",
});

function factLabel(label: string): string {
  return FACT_LABEL[label] ?? label.charAt(0).toUpperCase() + label.slice(1);
}

function sentence(text: string): string {
  const t = text.charAt(0).toUpperCase() + text.slice(1).trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function nextCard(item: QueueItem, reading: Reading, state: InspectState) {
  const listed =
    state.others?.id === item.id ? state.others.entries.filter((e) => e.state === "listed") : [];
  return {
    next: listed.length > 0 ? sentence(nextText(item, listed)) : reading.next,
    nextLinks: (item.links ?? []).map((l) => ({ label: "", value: l.label, href: l.url })),
  };
}

export function sourceOf(item: QueueItem): InspectField | undefined {
  if (!item.url) return undefined;
  if ([...item.cause, ...(item.links ?? [])].some((f) => f.url === item.url)) return undefined;
  return {
    label: "Source",
    value: item.kind === "approvals" ? "runs waiting for approval" : "open on GitHub",
    href: item.url,
  };
}

function whySection(item: QueueItem, said: string): InspectField[] {
  const facts = item.cause.filter(
    (f) => f.label !== "held" && !said.includes(f.value.toLowerCase()),
  );
  const fields: InspectField[] = facts.map((f) => ({
    label: factLabel(f.label),
    value: f.value,
    ...(f.url ? { href: f.url } : {}),
  }));
  const source = sourceOf(item);
  if (source) fields.push(source);
  return fields;
}

function relatedSection(reading: Reading): Reading["related"] {
  return reading.related.map((r) => ({
    text: r.text,
    state: r.state,
    ...(r.inspect ? { inspect: r.inspect } : r.url ? { url: r.url } : {}),
  }));
}

const ENTRY_ORDER: readonly EntryState[] = Object.freeze(["listed", "unlisted", "unread"]);
const ENTRY_BADGE: Readonly<Record<EntryState, { label: string; tone: Tone }>> = Object.freeze({
  absent: { label: "absent", tone: "neutral" },
  listed: { label: "listed", tone: "ok" },
  unlisted: { label: "unlisted", tone: "caution" },
  unread: { label: "?", tone: "neutral" },
});

interface SourcedRow {
  row: EntryRow;
  reads: ReadRecord[];
}

function unique(records: ReadRecord[]): ReadRecord[] {
  const seen = new Map<string, ReadRecord>();
  for (const record of records) seen.set(JSON.stringify(record), record);
  return [...seen.values()];
}

function entryRows(item: QueueItem, state: InspectState): SourcedRow[] | undefined {
  if (!item.halt || state.others?.id !== item.id) return undefined;
  const several = item.halt.entries.length > 1;
  const name = (e: ForkEntry) => (several ? `${e.fork} · ${e.entry}` : e.fork);
  const entries = state.others.entries;
  const rows = ENTRY_ORDER.flatMap((s) => entries.filter((e) => e.state === s)).map(
    (e): SourcedRow => ({
      row: {
        chip: { ...ENTRY_BADGE[e.state] },
        text: name(e),
        ...(e.verdict ? { trailing: e.verdict } : {}),
        ...(e.url ? { href: e.url } : {}),
      },
      reads: e.reads,
    }),
  );
  const absent = entries.filter((e) => e.state === "absent");
  if (absent.length > 0) {
    rows.push({
      row: {
        text: `${plural(absent.length, "fork")} ${absent.length === 1 ? "has" : "have"} no such entry upstream · ${names(absent.map(name))}`,
      },
      reads: unique(absent.flatMap((e) => e.reads)),
    });
  }
  return rows;
}

function sameEntry(item: QueueItem, state: InspectState): ItemInspection["sameEntry"] {
  if (!item.halt) return undefined;
  const rows = entryRows(item, state);
  if (!rows) {
    return state.reading === item.id
      ? { state: "reading", rows: [{ text: "reading each fork's filter and upstream tree" }] }
      : undefined;
  }
  return rows.length > 0 ? { state: "ready", rows: rows.map((r) => r.row) } : undefined;
}

/** The reads behind each ready FILTERS row, index-aligned with `sameEntry.rows`. */
export function sameEntryReads(item: QueueItem, state: InspectState): ReadRecord[][] | undefined {
  const rows = entryRows(item, state);
  return rows && rows.length > 0 ? rows.map((r) => r.reads) : undefined;
}

function evidence(item: QueueItem): InspectField[] {
  const source = sourceOf(item);
  return source ? [source] : [];
}

export function inspectItem(
  model: Model,
  item: QueueItem,
  now: Date,
  context: CoreContext,
  state: InspectState = {},
): ItemInspection {
  const reading = readItem(model, item, now, context);
  const since = age(item.since, now);
  const sinceWord = item.kind === "radar" ? "queued" : item.incident ? "open" : "waiting";
  const chip = [item.scope, since ? `${sinceWord} ${since}` : undefined, item.note?.replace(" behind", " held")]
    .filter(Boolean).join(" · ");
  const listed = !!item.approve?.length || item.effects.length > 1;
  const effect = listed || (item.effects.length === 0 && item.note) ? undefined : reading.effect;
  const lede = [reading.gap ? undefined : reading.cause, effect]
    .filter((t, i, all): t is string => !!t && all.indexOf(t) === i).join(" ");
  const same = sameEntry(item, state);
  return {
    ...reading,
    id: item.id,
    class: itemClass(item),
    status: statusOf(item),
    chip,
    lede,
    ...nextCard(item, reading, state),
    why: whySection(item, `${reading.cause} ${reading.effect}`.toLowerCase()),
    evidence: evidence(item),
    effects: item.effects.map((e) => ({ ...e })),
    related: relatedSection(reading),
    ...(same ? { sameEntry: same } : {}),
  };
}
