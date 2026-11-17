// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { FocusItem, Station, StationSubstate, TodayMember } from "@spi-code/contracts";

export const columns = [
  { id: "upstream", label: "Upstream" },
  { id: "sync", label: "Sync PR" },
  { id: "cascade", label: "Cascade" },
  { id: "main", label: "Main" },
  { id: "lane", label: "Lane" },
] as const;

type CellState = StationSubstate | "unread";
export const glyphs: Record<CellState, { mark: string; name: string }> = {
  stopped: { mark: "✕", name: "stopped" },
  "waiting-on-person": { mark: "!", name: "waits on you" },
  "in-progress": { mark: "◐", name: "running" },
  "waiting-on-clock": { mark: "◷", name: "waits on time" },
  unread: { mark: "⌀", name: "not read" },
  ready: { mark: "·", name: "fine" },
};

export function cellState(station: Station): CellState {
  if (station.state === "unknown" || !station.text.trim()) return "unread";
  if (station.state === "stopped") return "stopped";
  return station.substate;
}

const itemStations: Readonly<Record<string, readonly Station["id"][]>> = {
  halt: ["sync"],
  "sync-run": ["sync"],
  gate1: ["sync"],
  radar: ["upstream"],
  port: ["upstream"],
  conflict: ["cascade"],
  cascade: ["cascade"],
  labels: ["cascade"],
  main: ["main"],
  gate2: ["main"],
  "lane-deploy": ["lane"],
};

/** The Line station an item's kind is drawn at, from the same map the sheet's cells use. */
export function itemStation(id: string): Station["id"] | undefined {
  return itemStations[id.split(":")[0] ?? ""]?.[0];
}

/** Locate the briefing's existing items; no membership is inferred from a station's state. */
export function cellItems(items: readonly FocusItem[], service: string, station: Station["id"]) {
  return items.filter((item) => {
    if (item.rung === 2 || item.actor !== "operator" || item.scope !== service) return false;
    const kind = item.id.split(":")[0] ?? "";
    return (
      itemStations[kind]?.includes(station) ||
      (kind === "gate2" && station === "lane" && item.blockedBy === "stack:lanes")
    );
  });
}

export function cellText(station: Station, items: readonly FocusItem[]): string {
  if (cellState(station) === "unread") return station.text.trim() || "not read";
  if (cellState(station) === "in-progress" && /failed/.test(station.text))
    return "rerunning · last run failed";
  const halt = items.find((item) => item.id.startsWith("halt:"));
  const subject = halt?.title.match(/^Sync halted on (.+)$/)?.[1];
  return station.text
    .replace(/halted: ([A-Z][A-Z_]+)/, (_halt, code: string) =>
      (code === "UNKNOWN_TOP_LEVEL" || code === "UNKNOWN_TESTING_ENTRY") &&
      subject &&
      subject !== "an entry"
        ? `halted: no filter rule for ${subject}`
        : "sync halted",
    )
    .replace(/port owed/, "provider changes to port");
}

export function memberStations(member: TodayMember | undefined): readonly Station["id"][] {
  if (!member) return [];
  const kind = member.id.split(":")[0] ?? "";
  const stations = itemStations[kind] ?? [];
  return kind === "gate2" && member.blockedBy === "stack:lanes" ? [...stations, "lane"] : stations;
}
