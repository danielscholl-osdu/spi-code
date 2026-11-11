// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { AttentionTier } from "../attention.js";
import type { ReadingTile } from "../readings/index.js";
import type { Tone } from "./index.js";

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
const MARK = Object.freeze({
  interrupt: "stopped",
  surface: "needs-person",
  ambient: "in-progress",
  background: "nothing-due",
} as const);
const RANK = Object.freeze({ interrupt: 0, surface: 1, ambient: 2, background: 3 } as const);

export function placesOf(input: {
  readings: readonly PlaceReading[];
  items: readonly PlaceItem[];
  areas: readonly AreaEnvelope[];
}): PlaceRow[] {
  const homed = new Set<string>();
  return (["line", "environment", "engineering", "security"] as const).map((place) => {
    const kind = place === "line" ? "program" : place;
    const reading = input.readings.find(({ anchor }) => anchor.kind === kind)?.content;
    const members = new Set(reading?.itemIds ?? []);
    const items = input.items.filter((item) =>
      (members.has(item.id) || item.ids.some((id) => members.has(id))) &&
      !(place === "environment" && (item.id === "stack:lanes" || item.id.startsWith("lane-deploy:"))),
    );
    const itemIds = items.filter((item) => !homed.has(item.id)).map((item) => item.id);
    for (const id of itemIds) homed.add(id);
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
    const figure = !tile || tile.value === "not read yet" ? "not read yet" : place === "line" ? `${tile.value} stopped`
      : place === "security" ? `${tile.value} high or critical`
      : place === "engineering" ? `${tile.value} ${tile.counts}`
      : (reading?.headline.replace(/\.$/, "") ?? "not read yet");
    const reason = unread.length > 0 && tier === "background" && !stopped
      ? "Place reading is incomplete."
      : reading?.headline ?? "Place not read yet.";
    const line = place === "security" && tier === "background" && unread.length === 0
      ? "In SPI-owned shipped code, none blocking today."
      : reason;
    const caveat = reading?.qualifier?.replace(/, so /, ": ") ??
      (unread.length ? `${unread.join(", ")} not fully read; the figure covers only the evidence read.` : undefined);
    return {
      place, mark,
      tone: place === "security" ? "warn"
        : stopped ? "bad" : mark === "nothing-due" ? "neutral" : "warn",
      figure, line,
      ...(mark !== "nothing-due" ? { reason: line } : {}),
      ...(caveat ? { caveat } : {}),
      areas,
      ...(unread.length ? { unread: { areas: unread, ...(lastGood ? { lastGood } : {}) } } : {}),
      itemIds,
      fresh: { itemIds: [] },
    };
  });
}
