// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { heldRadar } from "../attention.js";
import type { Fleet } from "../config.js";
import type { ReadRecord } from "../evidence/index.js";
import type { Model } from "../model/index.js";
import { type LineModel, prRed, type Station } from "../model/lines.js";
import { syncSplit } from "../model/upstream.js";
import { fitHeadline, plural, since, wordCount } from "../util.js";
import { type SecurityReadingItem, serviceSecurityItem } from "./security.js";

export const READING_ITEMS = 5;

export interface ReadingTile {
  label: string;
  value: string;
  counts: string;
}

// The fields of a briefing item a reading reads; the item itself passes through unchanged.
export interface ReadingItem {
  id: string;
  ids: readonly string[];
  rung: number;
  cls: string;
  scope: string;
  title: string;
  sub: string;
  // When the item bites, once attention has projected it.
  due?: { at: string; before: string } | undefined;
}

export interface PlaceReading<T extends ReadingItem> {
  headline: string;
  qualifier?: string;
  tiles: [ReadingTile, ReadingTile, ReadingTile];
  items: (T & { group: string })[];
  folded: string | null;
}

export interface ReadingGroup<T extends ReadingItem> {
  group: string;
  items: readonly T[];
}

export interface ReadingParts<T extends ReadingItem> {
  headline: string;
  qualifier?: string;
  tiles: [ReadingTile, ReadingTile, ReadingTile];
  groups: readonly ReadingGroup<T>[];
  // Words for the items past the cap; without it they fold as a list of titles.
  fold?: (rest: readonly T[]) => string;
  // A line folded in whether or not items overflow.
  extra?: string;
}

// Raw issue and check titles carry emoji; a reading shows their words alone.
const EMOJI = /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*\uFE0F?/gu;

export function plainText(text: string): string {
  return text.replace(EMOJI, "").replace(/\s{2,}/g, " ").trim();
}

function plainTile(tile: ReadingTile): ReadingTile {
  return { label: plainText(tile.label), value: plainText(tile.value), counts: plainText(tile.counts) };
}

// One shape for every place: groups in order, at most five items, the rest folded into a line.
// Display text loses its emoji; ids, evidence and the other item fields pass through unchanged.
export function placeReading<T extends ReadingItem>(parts: ReadingParts<T>): PlaceReading<T> {
  const seen = new Set<string>();
  const all: (T & { group: string })[] = [];
  for (const { group, items } of parts.groups) {
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      all.push({
        ...item,
        scope: plainText(item.scope),
        title: plainText(item.title),
        sub: plainText(item.sub),
        group,
      });
    }
  }
  const rest = all.slice(READING_ITEMS);
  const fold = rest.length > 0 ? (parts.fold ?? foldItems)(rest) : undefined;
  const qualifier = parts.qualifier ? plainText(parts.qualifier) : "";
  const [a, b, c] = parts.tiles;
  return {
    headline: plainText(parts.headline),
    ...(qualifier ? { qualifier } : {}),
    tiles: [plainTile(a), plainTile(b), plainTile(c)],
    items: all.slice(0, READING_ITEMS),
    folded: plainText([fold, parts.extra].filter(Boolean).join(" ")) || null,
  };
}

function foldItems(rest: readonly ReadingItem[]): string {
  return `${plural(rest.length, "more item")}: ${rest.map((i) => `${i.scope} ${lower(i.title)}`).join(", ")}.`;
}

// Words the rib uses internally that a reading must not show.
const INTERNAL: readonly { name: string; pattern: RegExp }[] = Object.freeze([
  { name: "fork_upstream", pattern: /\bfork_upstream\b/i },
  { name: "fork_integration", pattern: /\bfork_integration\b/i },
  { name: "gate N", pattern: /\bgate \d\b/i },
  { name: "presses", pattern: /\bpress(es)?\b/i },
  { name: "cut as a label", pattern: /(^|\s)cut\s*[:·]|^cut$/i },
]);

export function internalNames(text: string): string[] {
  return INTERNAL.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
}

// Every line of text a reading shows, in reading order.
export function readingText(reading: PlaceReading<ReadingItem>): string[] {
  const groups: string[] = [];
  for (const item of reading.items) if (!groups.includes(item.group)) groups.push(item.group);
  return [
    reading.headline,
    ...(reading.qualifier ? [reading.qualifier] : []),
    ...reading.tiles.flatMap((t) => [t.label, t.value, t.counts]),
    ...groups.flatMap((group) => [
      group,
      ...reading.items.filter((i) => i.group === group).flatMap((i) => [i.scope, i.title, i.sub]),
    ]),
    ...(reading.folded ? [reading.folded] : []),
  ];
}

export { wordCount };

export function readingWords(reading: PlaceReading<ReadingItem>): number {
  return readingText(reading).reduce((sum, line) => sum + wordCount(line), 0);
}

const NUMBERS = Object.freeze(["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven"]);

function lower(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// The daily sync is always less than a day away, so its local clock time names it.
export function clockOf(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export const NOT_READ = "not read yet";

function serviceOf(read: ReadRecord, fleet: Fleet): string {
  return fleet.forks.find((f) => f.upstream === read.source || f.repo === read.source)?.id ?? read.source;
}

function servicesWhere(
  reads: readonly ReadRecord[],
  fleet: Fleet,
  test: (read: ReadRecord) => boolean,
): string[] {
  const services: string[] = [];
  for (const read of reads) {
    if (!test(read)) continue;
    const service = serviceOf(read, fleet);
    if (!services.includes(service)) services.push(service);
  }
  return services;
}

const isCut = (read: ReadRecord): boolean => read.completeness.kind === "cut";
const isFailed = (read: ReadRecord): boolean => read.failure !== undefined;

// The services whose upstream reads GitLab cut, from the radar's own read records.
export function cutServices(reads: readonly ReadRecord[], fleet: Fleet): string[] {
  return servicesWhere(reads, fleet, isCut);
}

// The services with a radar read that failed outright.
export function failedServices(reads: readonly ReadRecord[], fleet: Fleet): string[] {
  return servicesWhere(reads, fleet, isFailed);
}

// A campaign as the host detects it; only toolchain campaigns read on Upstream.
export interface ReadingCampaign {
  id: string;
  kind: string;
  fact: string;
  forks: readonly string[];
}

export function campaignTitle(campaign: ReadingCampaign): string {
  return `Detected: ${campaign.fact} on ${plural(campaign.forks.length, "fork")}`;
}

// One item for a campaign, built on its members' radar items so it keeps their shape. It carries
// no action: tracking a campaign is not offered yet.
function campaignItem<T extends ReadingItem>(campaign: ReadingCampaign, members: readonly T[]): T {
  const [base] = members;
  const item: Record<string, unknown> = {
    ...base,
    id: campaign.id,
    ids: [...new Set(members.flatMap((m) => m.ids))],
    rung: 2,
    scope: plural(campaign.forks.length, "fork"),
    title: campaignTitle(campaign),
    sub: "",
  };
  if ("cause" in item) item.cause = `${plural(campaign.forks.length, "fork")} move to ${campaign.fact}.`;
  if ("effect" in item) item.effect = "";
  if ("next" in item) item.next = "";
  if ("verb" in item) item.verb = "";
  if (Array.isArray(item.evidence)) {
    const seen = new Set<string>();
    item.evidence = members
      .flatMap((m) => (m as unknown as { evidence: unknown[] }).evidence)
      .filter((link) => {
        const key = JSON.stringify(link);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }
  delete item.more;
  return item as unknown as T;
}

function readQualifier(cut: number, failed: number, subject: string, unit: string): string | undefined {
  const parts = [
    cut > 0 ? `GitLab truncated the upstream diffs for ${plural(cut, unit)}` : undefined,
    failed > 0 ? `${cut > 0 ? "the" : "The"} reads failed for ${plural(failed, unit)}` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? `${parts.join(" and ")}, so ${subject} could be missing.` : undefined;
}

export interface UpstreamReadingInput<T extends ReadingItem> {
  model: Model;
  items: readonly T[];
  radar: readonly ReadRecord[];
  fleet: Fleet;
  campaigns: readonly ReadingCampaign[];
}

export function upstreamReading<T extends ReadingItem>(
  input: UpstreamReadingInput<T>,
): PlaceReading<T> {
  const { model, items, radar, fleet, campaigns } = input;
  const up = model.upstream;
  // An instant, not a clock time: the window reads it in its own zone.
  const at = up.schedule.upstream;
  const moving = up.moving;
  const total = up.forks.length;
  const unread = up.unread;
  const none = total === 0 || unread >= total;
  const commits = moving.reduce((sum, f) => sum + (f.behind ?? 0), 0);
  const splits = moving.map(syncSplit);
  const arriving = splits.filter((s) => s.next > 0);
  const prs = splits.filter((s) => s.pr !== undefined).length;
  const queued = arriving.reduce((sum, s) => sum + s.next, 0);
  const inPrs = commits - queued;
  const held = up.held.map((f) => f.service);
  const radarItem = (service: string) => items.find((i) => i.id === `radar:${service}`);
  const before = held.map(radarItem).filter((i): i is T => !!i);

  // A fleet fact shows once, on its campaign; a move only one fork carries stays that fork's item.
  const covered = new Set<string>();
  const detected: T[] = [];
  const toolchains = campaigns
    .filter((c) => c.kind === "toolchain")
    .sort((a, b) => b.forks.length - a.forks.length || a.fact.localeCompare(b.fact));
  for (const campaign of toolchains) {
    const forks = campaign.forks.filter((s) => !held.includes(s));
    const members = forks.map(radarItem).filter((i): i is T => !!i);
    if (members.length === 0) continue;
    for (const s of forks) covered.add(s);
    detected.push(campaignItem(campaign, members));
  }
  const move = up.moves.find((m) => !/SNAPSHOT/i.test(m.value));
  const moveForks = move ? move.forks.filter((s) => !held.includes(s) && !covered.has(s)) : [];
  const toolchain = items.filter((i) => moveForks.some((s) => i.id === `radar:${s}`));
  const others = items.filter(
    (i) =>
      i.id.startsWith("radar:") &&
      !before.includes(i) &&
      !toolchain.includes(i) &&
      !covered.has(i.id.slice("radar:".length)),
  );
  const still = up.forks.filter(
    (f) => (f.behind ?? 0) > 0 && !moving.some((m) => m.service === f.service),
  );

  const first =
    before.length > 0
      ? ` ${NUMBERS[before.length] ?? before.length} ${before.length === 1 ? "needs" : "need"} you first.`
      : "";
  const unreadNote = unread > 0 ? ` · ${unread} ${NOT_READ}` : "";
  const when = at ? `At ${at}` : "At the next sync";
  const reach = `${when}, ${plural(queued, "commit")} reach ${plural(arriving.length, "fork")}`;
  const wait = `${plural(inPrs, "commit")} wait in ${plural(prs, "open sync PR")}`;
  const inSync = prs === 1 ? "a sync PR" : "sync PRs";
  const headline = none
    ? `Upstream ${NOT_READ}.`
    : commits === 0
      ? unread > 0
        ? `Nothing queued on the forks read; ${unread} ${NOT_READ}.`
        : "Nothing queued upstream for the next sync."
      : prs === 0
        ? `${reach}.${first}`
        : queued === 0
          ? `${wait}.${first}`
          : fitHeadline([
              `${reach}; ${inPrs} wait in ${inSync}.${first}`,
              `${reach}; ${inPrs} in ${inSync}.${first}`,
              `${reach}.${first}`,
            ]);
  const qualifier = readQualifier(
    cutServices(radar, fleet).length,
    failedServices(radar, fleet).length,
    "a toolchain move",
    "service",
  );
  const [top, ...next] = [...moving].sort((a, b) => (b.behind ?? 0) - (a.behind ?? 0));
  const then = next
    .slice(0, 2)
    .map((f) => `${f.service} ${f.behind ?? 0}`)
    .join(", ");
  const [lead, ...also] = toolchains.filter((c) => detected.some((i) => i.id === c.id));
  const tiles: [ReadingTile, ReadingTile, ReadingTile] = none
    ? [
        { label: "Incoming", value: NOT_READ, counts: `commits · ${plural(total, "fork")}` },
        { label: "Toolchain", value: NOT_READ, counts: "moves to a released toolchain" },
        { label: "Largest", value: NOT_READ, counts: "commits behind" },
      ]
    : [
        {
          label: "Incoming",
          value: String(commits),
          counts:
            prs === 0
              ? `commits · ${moving.length} of ${plural(total, "fork")}${unreadNote}`
              : `commits · ${inPrs} in ${plural(prs, "sync PR")} · ${queued} ${at ? `at ${at}` : "at the next sync"}${unreadNote}`,
        },
        lead
          ? {
              label: "Toolchain",
              value: plural(lead.forks.length, "fork"),
              counts: `move to ${lead.fact}${also.length > 0 ? ` · ${plural(also.length, "more move")}` : ""}`,
            }
          : move
            ? {
                label: "Toolchain",
                value: plural(move.forks.filter((s) => !held.includes(s)).length, "fork"),
                counts: `move to ${move.value}`,
              }
            : {
                label: "Toolchain",
                value: "0 forks",
                counts: `move to a released toolchain${unreadNote}`,
              },
        top
          ? {
              label: "Largest",
              value: String(top.behind ?? 0),
              counts: `commits · ${top.service}${then ? ` · then ${then}` : ""}`,
            }
          : {
              label: "Largest",
              value: "0",
              counts: unread > 0 ? `commits · no fork read is behind${unreadNote}` : "commits · no fork behind",
            },
      ];
  const extra =
    still.length > 0
      ? `${still.map((f) => `${f.service} takes ${plural(f.behind ?? 0, "commit")}`).join(", ")} with no toolchain move.`
      : undefined;
  return placeReading({
    headline,
    ...(qualifier ? { qualifier } : {}),
    tiles,
    groups: [
      { group: at ? `Before ${at}` : "Before the next sync", items: before },
      { group: "Toolchain", items: [...detected, ...toolchain, ...others] },
    ],
    fold: (rest) => {
      const moved = rest.filter((i) => moveForks.includes(i.scope));
      const left = rest.filter((i) => !moveForks.includes(i.scope));
      return [
        move && moved.length > 0
          ? `${plural(moved.length, "more fork")} move to ${move.value}: ${moved.map((i) => i.scope).join(", ")}.`
          : undefined,
        left.length > 0 ? foldItems(left) : undefined,
      ]
        .filter(Boolean)
        .join(" ");
    },
    ...(extra ? { extra } : {}),
  });
}

const STATION_NAME: Readonly<Partial<Record<Station["id"], string>>> = Object.freeze({
  sync: "sync PR",
  cascade: "cascade",
  main: "sync to main",
});

const STATE_RANK: Readonly<Record<Station["state"], number>> = Object.freeze({
  stopped: 0,
  waiting: 1,
  moving: 2,
  unknown: 3,
  idle: 4,
});

function stationWords(station: Station): string {
  const pr = /PR #(\d+)/.exec(station.text)?.[1];
  if (station.id === "sync" && station.state === "waiting" && pr) return `PR #${pr} waits for review`;
  if (station.id === "main" && pr)
    return station.state === "stopped" ? `PR #${pr} is red` : `PR #${pr} waits for approval`;
  return station.text;
}

function lineTile(line: LineModel): ReadingTile {
  if (!line.repoRead && !line.runsRead)
    return { label: "Line", value: NOT_READ, counts: "sync PR, cascade and sync to main" };
  const open = line.stations
    .filter((s) => STATION_NAME[s.id] && s.state !== "idle")
    .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state]);
  const [worst, ...more] = open;
  if (!worst) return { label: "Line", value: "Clear", counts: "sync PR, cascade and sync to main idle" };
  return {
    label: "Line",
    value: cap(worst.state),
    counts: `${STATION_NAME[worst.id]} · ${stationWords(worst)}${
      more.length > 0 ? ` · ${plural(more.length, "more station")} open` : ""
    }`,
  };
}

function upstreamTile(line: LineModel): ReadingTile {
  const lag = line.upstream?.lag;
  const station = line.stations.find((s) => s.id === "upstream");
  if (lag === undefined || !station || station.state === "unknown")
    return { label: "Upstream", value: NOT_READ, counts: "commits behind" };
  const detail = station.text.split(" · ").slice(1).join(" · ");
  return {
    label: "Upstream",
    value: String(lag),
    counts: `commits behind · ${detail || (lag === 0 ? "nothing queued" : "no toolchain move")}`,
  };
}

function releaseTile(line: LineModel, now: Date): ReadingTile {
  const last = line.release?.tag;
  const p = line.releasePr;
  if (!p && !last && !line.repoRead)
    return { label: "Release", value: NOT_READ, counts: "latest release" };
  if (!p)
    return {
      label: "Release",
      value: last ?? "none",
      counts: last ? "latest release · no release review open" : "releases · none yet",
    };
  const failing = p.failures.find((f) => f.cls !== "POLICY");
  return {
    label: "Release review",
    value: `PR #${p.pr.number}`,
    counts: [
      prRed(p) ? (failing ? `fails ${failing.check}` : "checks fail") : "checks pass",
      `open ${since(p.pr.createdAt, now)}`,
      last ? `last release ${last}` : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

function headlineOf(line: LineModel, radar: ReadingItem | undefined): string {
  const n = (p: { pr: { number: number } } | undefined) => (p ? ` #${p.pr.number}` : "");
  switch (line.pill.label) {
    case "main red":
      return "Main fails validation.";
    case "sync halted":
      return `Sync Upstream halted${line.halt ? ` on ${line.halt.code}` : ""}.`;
    case "template halted":
      return "Template sync stopped.";
    case "cascade blocked":
      return line.conflicts.length > 0 ? "Cascade stopped on a merge conflict." : "Cascade stopped.";
    case "sync blocked":
      return `Sync PR${n(line.syncPr)} fails its checks.`;
    case "template blocked":
      return `Template-sync PR${n(line.templatePr)} fails its checks.`;
    case "template stale":
      return "Template sync has gone stale.";
    case "gate 1 waiting":
      return `Sync PR${n(line.syncPr)} waits for review.`;
    case "gate 2 waiting":
      return `Sync to main PR${n(line.cascadePr)} waits for approval.`;
    case "behind":
      if (radar) return `${radar.title}.`;
      return `${plural(line.upstream?.lag ?? 0, "upstream commit")} wait for the daily sync.`;
    case "template update":
      return `Template update PR${n(line.templatePr)} is open.`;
    case "template behind":
      return "Behind the template.";
    case "lag unmeasured":
      return "Upstream lag not measured.";
    case "template unmeasured":
      return "Template position not measured.";
    default:
      return "Current with upstream and the template.";
  }
}

function templateLine(line: LineModel): string | undefined {
  const behind = line.template.behind;
  if (behind === undefined) return undefined;
  if (behind === 0) return "Template: current with osdu-spi.";
  const pr = line.templatePr ? `; template-sync PR #${line.templatePr.pr.number} open` : "";
  return `Template: ${plural(behind, "commit")} behind osdu-spi${pr}.`;
}

function serviceQualifier(reads: readonly ReadRecord[]): string | undefined {
  const cut = reads.some(isCut);
  const failed = reads.filter(isFailed).length;
  const failure = failed === 1 ? "a read failed" : `${failed} reads failed`;
  if (cut && failed > 0)
    return `GitLab truncated this service's upstream diffs and ${failure}, so this reading could be missing something.`;
  if (cut) return "GitLab truncated this service's upstream diffs, so a toolchain move could be missing.";
  if (failed > 0) return `${cap(failure)} for this service, so this reading could be missing something.`;
  return undefined;
}

// A service place shows only what is scoped to the service; fleet aggregates stay on Today.
function belongs(item: ReadingItem, service: string): boolean {
  return item.scope === service;
}

export interface ServiceReadingInput<T extends ReadingItem> {
  model: Model;
  service: string;
  items: readonly T[];
  // Every read record the sweep kept; the reading qualifies itself on this service's failed or cut ones.
  reads: readonly ReadRecord[];
  now: Date;
}

export function serviceReading<T extends ReadingItem>(
  input: ServiceReadingInput<T>,
): PlaceReading<T | SecurityReadingItem> | null {
  const { model, service, items, reads, now } = input;
  const line = model.lines.find((l) => l.fork.id === service);
  if (!line) return null;
  const next = model.upstream.schedule.upstream;
  type Item = T | SecurityReadingItem;
  const queued = (i: Item): boolean => {
    if (!i.id.startsWith("radar:")) return false;
    const q = model.queue.items.find((q) => q.id === i.id);
    return q === undefined || !heldRadar(q, model);
  };
  const bite = (i: Item): string | undefined => i.due?.at ?? (queued(i) ? next : undefined);
  const groupOf = (i: Item): string => {
    if (i.rung === 0) return "Stopped";
    const at = bite(i);
    if (at) return `Before ${clockOf(at)}`;
    return i.rung === 1 ? "Needs a decision" : i.cls === "SECURITY" ? "Security" : "Ready to move";
  };
  const tier = (i: Item): number => (i.rung === 0 ? 0 : bite(i) ? 1 : i.rung === 1 ? 2 : 3);
  const time = (i: Item): number => (tier(i) === 1 ? Date.parse(bite(i) as string) : 0);
  const security = serviceSecurityItem(
    service,
    model.repositories.rows.find((row) => row.repo === line.fork.repo),
  );
  const own = [security, ...items.filter((i) => belongs(i, service))]
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        tier(a.item) - tier(b.item) || time(a.item) - time(b.item) || a.index - b.index,
    )
    .map(({ item }) => item);
  const groups: ReadingGroup<Item>[] = [];
  for (const item of own) {
    const group = groupOf(item);
    const found = groups.find((g) => g.group === group);
    if (found) (found.items as Item[]).push(item);
    else groups.push({ group, items: [item] });
  }
  const qualifier = serviceQualifier(
    reads.filter((r) => r.source === line.fork.repo || r.source === line.fork.upstream),
  );
  const radar = own.find((i) => i.id === `radar:${service}`);
  const extra = templateLine(line);
  return placeReading({
    headline: headlineOf(line, radar),
    ...(qualifier ? { qualifier } : {}),
    tiles: [upstreamTile(line), lineTile(line), releaseTile(line, now)],
    groups,
    ...(extra ? { extra } : {}),
  });
}
