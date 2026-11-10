// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { isStoppedFork, type StationSubstate, type ViewSnapshot } from "@spi-code/contracts";

/** The four pip states the strip draws; a scheduled station has nothing due from a person. */
export type PipState = "stopped" | "needs-person" | "in-progress" | "nothing-due";

export const PIPS: Readonly<Record<PipState, { mark: string; words: string }>> = {
  stopped: { mark: "✕", words: "stopped" },
  "needs-person": { mark: "!", words: "needs a person" },
  "in-progress": { mark: "◐", words: "in progress" },
  "nothing-due": { mark: "○", words: "nothing due" },
};

const RANK: Readonly<Record<StationSubstate, number>> = {
  stopped: 4,
  "waiting-on-person": 3,
  "in-progress": 2,
  "waiting-on-clock": 1,
  ready: 0,
};

const PIP_OF: Readonly<Record<StationSubstate, PipState>> = {
  stopped: "stopped",
  "waiting-on-person": "needs-person",
  "in-progress": "in-progress",
  "waiting-on-clock": "nothing-due",
  ready: "nothing-due",
};

export type StripPip = { service: string; state: PipState };

/** Every field is absent when the snapshot carries nothing for it, so the strip draws nothing there. */
export type StripFields = {
  pips: StripPip[];
  stopped: string[];
  environment?: { version: string; state: string };
  template?: { verified: number; total: number; target: string };
  due?: { count: number; before: string };
  nextSync?: string;
};

/** A service's worst sub-state over its line stations; the stack lane is not one of them. */
function worst(stations: ViewSnapshot["stations"][number]["stations"]): StationSubstate {
  if (isStoppedFork(stations)) return "stopped";
  return stations
    .filter(({ id }) => id !== "lane")
    .reduce<StationSubstate>(
      (held, { substate }) => (RANK[substate] > RANK[held] ? substate : held),
      "ready",
    );
}

/** The strip's fields from a snapshot, pips in the snapshot's fleet order. */
export function selectStrip(snapshot: ViewSnapshot): StripFields {
  const pips = snapshot.stations.map(({ service, stations }) => ({
    service,
    state: PIP_OF[worst(stations)],
  }));
  const fields: StripFields = {
    pips,
    stopped: pips.filter(({ state }) => state === "stopped").map(({ service }) => service),
  };
  const { facts, nextSyncAt, focus, rest } = snapshot.briefing;
  const env = facts.find(({ label }) => label === "Environment");
  if (env && env.figure !== "?") {
    fields.environment = { version: env.figure, state: env.sub.split(" · ")[0] ?? "" };
  }
  const adoption = snapshot.readings.find(({ anchor }) => anchor.kind === "engineering")?.content
    ?.verifiedTemplate;
  if (adoption && adoption.total > 0 && adoption.unread < adoption.total) {
    fields.template = {
      verified: adoption.verified,
      total: adoption.total,
      target: adoption.target.slice(0, 7),
    };
  }
  const due = new Map<string, number>();
  for (const item of [...focus, ...rest]) {
    if (item.due) due.set(item.id, Date.parse(item.due.at));
  }
  const before =
    nextSyncAt ?? (due.size > 0 ? new Date(Math.max(...due.values())).toISOString() : undefined);
  if (before !== undefined) {
    const count = [...due.values()].filter((at) => at <= Date.parse(before)).length;
    if (count > 0) fields.due = { count, before };
  }
  if (nextSyncAt !== undefined) fields.nextSync = nextSyncAt;
  return fields;
}
