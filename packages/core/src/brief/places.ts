// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { AttentionTier } from "../attention.js";
import type { Model } from "../model/index.js";
import { stationSubstateOf } from "../model/substate.js";
import type { ReadingTile } from "../readings/index.js";
import type { Tone } from "./index.js";
import { type PlaceVisual, placeVisuals, type VisualSource } from "./place-visuals.js";

type PlaceId = "line" | "environment" | "engineering" | "security";
type Mark = "stopped" | "needs-person" | "in-progress" | "nothing-due";
interface PlaceRow {
  place: PlaceId;
  mark: Mark;
  tone: Tone;
  figure: string;
  line: string;
  reason?: string;
  caveat?: string;
  areas: AreaName[];
  unread?: { areas: AreaName[]; lastGood?: string };
  itemIds: string[];
  fresh: { itemIds: string[] };
  visual?: PlaceVisual;
}
interface PlaceReading {
  anchor: { kind: string };
  content: {
    headline: string;
    qualifier?: string | undefined;
    tiles: readonly ReadingTile[];
    itemIds?: readonly string[] | undefined;
  } | null;
}
interface PlaceItem {
  id: string;
  ids: readonly string[];
  attention: AttentionTier;
}
interface AreaEnvelope {
  area: AreaName;
  envelope: { state: string; observedAt?: string | undefined };
}
import type { AreaName } from "../facts.js";

const AREAS: Readonly<Record<PlaceId, readonly AreaName[]>> = Object.freeze({
  line: ["github", "runs", "approvals", "lifecycle", "details", "upstream", "radar", "template"],
  environment: ["github", "lifecycle"],
  engineering: ["github", "runs", "template"],
  security: ["radar", "template", "security"],
});
const AREA_NAMES: Readonly<Record<AreaName, string>> = Object.freeze({
  fleet: "Fleet membership",
  github: "GitHub issues and PRs",
  runs: "Workflow runs",
  approvals: "Run approvals",
  lifecycle: "Stack lifecycle runs",
  details: "Run details",
  upstream: "Upstream GitLab",
  radar: "Upstream radar",
  template: "Template",
  auth: "Sign-in",
  security: "Security alerts",
});
const MARK = Object.freeze({
  interrupt: "stopped",
  surface: "needs-person",
  ambient: "in-progress",
  background: "nothing-due",
} as const);
const RANK = Object.freeze({ interrupt: 0, surface: 1, ambient: 2, background: 3 } as const);

const NOT_READ = "not read yet";
const INCOMPLETE = "Place reading is incomplete.";

function stoppedStations({ model, facts }: VisualSource): string[] {
  const at = new Map<string, number>();
  for (const line of model.lines)
    line.stations.forEach((station, index) => {
      if (stationSubstateOf(station, line, facts) === "stopped")
        at.set(station.id, Math.min(at.get(station.id) ?? index, index));
    });
  return [...at].sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

function environmentFigure(stack: Model["stack"]): string {
  const version = stack.running?.version ?? stack.declared;
  if (!version) return NOT_READ;
  if (stack.inflight || stack.deployable.state === "no") return `${version} not deployable`;
  if (stack.deployable.state === "yes") return `${version} deployable`;
  return stack.history.held ? `${version} unproven` : NOT_READ;
}

function engineeringReason({ template, rollout }: Model): string {
  const total = template.rows.length;
  const target = rollout?.target.sha ?? template.head?.sha;
  const unread = template.rows.filter((row) => row.behind === undefined).length;
  if (!target || total === 0 || unread === total) return INCOMPLETE;
  if (rollout?.phase === "stopped") return "rollout stopped";
  if (template.verified === total) return "all verified";
  if (rollout?.phase === "ready") return "ready to roll out";
  return "verification pending";
}

function itemsReason(place: PlaceId, items: readonly PlaceItem[]): string | undefined {
  const asking = items.filter((item) => item.attention === "interrupt" || item.attention === "surface");
  if (place === "line" && asking.some((item) => item.id === "stack:lanes" || item.id.startsWith("lane-deploy:")))
    return "lane re-run owed";
  if (asking.length) return `${asking.length} ${asking.length === 1 ? "needs" : "need"} you`;
  const moving = items.filter((item) => item.attention === "ambient").length;
  return moving ? `${moving} in progress` : undefined;
}

function compactReason(place: PlaceId, mark: Mark, source: VisualSource, items: readonly PlaceItem[]): string | undefined {
  if (place === "engineering") return engineeringReason(source.model);
  if (place === "line" && mark === "stopped") {
    const stations = stoppedStations(source);
    if (stations.length) return `stations: ${stations.join(", ")}`;
  }
  if (place === "environment") {
    const stack = source.model.stack;
    if (stack.inflight) return `${stack.inflight.run.kind} running`;
    if (stack.deployable.state === "no") return "in maintenance";
  }
  return itemsReason(place, items);
}

export function placesOf(input: {
  readings: readonly PlaceReading[];
  items: readonly PlaceItem[];
  areas: readonly AreaEnvelope[];
  source: VisualSource;
}): PlaceRow[] {
  const visuals = placeVisuals(input.source, input.items);
  return (["line", "environment", "engineering", "security"] as const).map((place) => {
    const kind = place === "line" ? "program" : place;
    const reading = input.readings.find(({ anchor }) => anchor.kind === kind)?.content;
    const members = new Set(reading?.itemIds ?? []);
    const items = input.items.filter((item) =>
      (members.has(item.id) || item.ids.some((id) => members.has(id))) &&
      !(place === "environment" && (item.id === "stack:lanes" || item.id.startsWith("lane-deploy:"))),
    );
    const itemIds = items.map((item) => item.id);
    const tier = items.reduce<AttentionTier>((worst, item) =>
      RANK[item.attention] < RANK[worst] ? item.attention : worst, "background");
    const areas = [...AREAS[place]];
    const unread = areas.filter((area) => {
      const envelope = input.areas.find((entry) => entry.area === area)?.envelope;
      return !envelope || envelope.state === "unread" || envelope.state === "failed" || envelope.state === "incomplete";
    });
    const times = unread.map((area) => {
      const envelope = input.areas.find((entry) => entry.area === area)?.envelope;
      return envelope && envelope.state !== "unread" ? envelope.observedAt : undefined;
    });
    const lastGood = times.length > 0 && times.every((time) => time !== undefined)
      ? (times as string[]).sort((a, b) => Date.parse(a) - Date.parse(b))[0]
      : undefined;
    const tile = reading?.tiles[0];
    const stopped = place === "line" && /^(?:At least )?[1-9]\d* of /.test(tile?.value ?? "");
    const mark = stopped ? "stopped" : (unread.length > 0 || !reading) && tier === "background" ? "in-progress" : MARK[tier];
    const placeUnread = !reading || unread.length === areas.length || !tile || tile.value === NOT_READ;
    const figure = placeUnread ? NOT_READ : place === "line" ? `${tile.value} stopped`
      : place === "security" ? `${tile.value} high or critical`
      : place === "engineering" ? `${tile.value} ${tile.counts}`
      : environmentFigure(input.source.model.stack);
    const incomplete = unread.length > 0 && tier === "background" && !stopped;
    const line = place === "security" && tier === "background" && unread.length === 0
      ? "In SPI-owned shipped code, none blocking today."
      : incomplete ? INCOMPLETE : reading?.headline ?? "Place not read yet.";
    const reason = placeUnread || incomplete || figure === NOT_READ
      ? INCOMPLETE
      : compactReason(place, mark, input.source, items);
    const caveat = reading?.qualifier?.replace(/, so /, ": ") ??
      (unread.length ? `${unread.map((area) => AREA_NAMES[area]).join(", ")} not fully read; the figure covers only the evidence read.` : undefined);
    return {
      place, mark,
      tone: place === "security" ? "warn"
        : mark === "stopped" ? "bad" : mark === "nothing-due" ? "neutral" : "warn",
      figure, line,
      ...(mark !== "nothing-due" && reason ? { reason } : {}),
      ...(caveat ? { caveat } : {}),
      areas,
      ...(unread.length ? { unread: { areas: unread, ...(lastGood ? { lastGood } : {}) } } : {}),
      itemIds,
      fresh: { itemIds: [] },
      ...(visuals[place] ? { visual: visuals[place] } : {}),
    };
  });
}
