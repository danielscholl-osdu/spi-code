// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { AttentionTier } from "../attention.js";
import type { ReadRecord } from "../evidence/index.js";
import type { Facts } from "../facts.js";
import type { Model } from "../model/index.js";
import { stationSubstateOf } from "../model/substate.js";
import { type PlaceReading, placeReading, type ReadingItem } from "./index.js";

interface ProgramItem extends ReadingItem {
  attention?: AttentionTier;
}

export interface ProgramReadingInput<T extends ProgramItem> {
  model: Model;
  facts: Pick<Facts, "github" | "runs" | "approvals" | "lifecycle" | "details" | "upstream" | "radar" | "template">;
  items: readonly T[];
  reads: Partial<Record<"github" | "runs" | "approvals" | "lifecycle" | "details" | "upstream" | "radar" | "template", readonly ReadRecord[]>>;
}

export function programReading<T extends ProgramItem>(input: ProgramReadingInput<T>): PlaceReading<T> {
  const { model, facts, items } = input;
  const stopped = model.lines.flatMap((line) => {
    const stations = line.stations.filter((station) =>
      station.id !== "lane" && stationSubstateOf(station, line, facts) === "stopped",
    );
    return stations.length ? [`${line.fork.id} (${stations.map((station) => station.id).join(", ")})`] : [];
  });
  const lanes = model.lines.filter((line) => line.stations.some((station) =>
    station.id === "lane" && station.text !== "blocked by the stack" && stationSubstateOf(station, line, facts) === "stopped",
  )).map((line) => line.fork.id);
  const stoppedForks = model.lines.filter((line) => line.stations.some((station) =>
    stationSubstateOf(station, line, facts) === "stopped",
  )).length;
  const waiting = model.lines.filter((line) => line.stations.some((station) =>
    stationSubstateOf(station, line, facts) === "waiting-on-person",
  )).map((line) => line.fork.id);
  const unread = model.lines.filter((line) => !line.repoRead).length;
  const services = new Set(model.lines.map((line) => line.fork.id));
  const own = items.filter((item) => item.id === "stack:lanes" || item.id.startsWith("lane-deploy:") ||
    (services.has(item.scope) && item.cls !== "SECURITY" && !item.id.startsWith("radar:") && !item.id.startsWith("template-pr:")));
  const incomplete = unread > 0 || (["github", "runs", "approvals", "lifecycle", "details", "upstream", "radar", "template"] as const)
    .some((area) => !facts[area].data || facts[area].error || !input.reads[area]?.length ||
      input.reads[area]?.some((read) => read.failure !== undefined || read.completeness.kind === "cut")) || model.lines.some((line) => !line.runsRead);
  const asking = own.filter((item) => item.attention === "interrupt" || item.attention === "surface");
  const moving = own.filter((item) => item.attention === "ambient");
  const owed = asking.some((item) => item.id === "stack:lanes" || item.id.startsWith("lane-deploy:"))
    ? "A fork lane re-run is owed."
    : asking.length ? `Waiting on you: ${[...new Set(asking.map((item) => item.scope))].join(", ")}.`
      : moving.length ? `Fork work is in progress: ${[...new Set(moving.map((item) => item.scope))].join(", ")}.` : undefined;
  const headline = [
    stopped.length ? `Stopped: ${stopped.join(", ")}.` : undefined,
    lanes.length ? `Failed lanes: ${lanes.join(", ")}.` : undefined,
  ].filter(Boolean).join(" ") || (stoppedForks > 0
    ? "Fork lanes are blocked by the environment."
    : waiting.length ? `Waiting on people: ${waiting.join(", ")}.`
      : owed ?? (incomplete ? "Some fork stations are not read yet." : "No fork stations are stopped."));
  return placeReading({
    membership: true,
    headline,
    ...(unread ? { qualifier: `${unread} forks' repository stations not read yet.` } : {}),
    tiles: [
      { label: "Line", value: unread === model.lines.length ? "not read yet" : `${incomplete ? "At least " : ""}${stoppedForks} of ${model.lines.length}`, counts: "forks stopped" },
      { label: "Lanes", value: String(lanes.length), counts: "failed fork lanes" },
      { label: "Read", value: `${model.lines.length - unread} of ${model.lines.length}`, counts: "fork repositories read" },
    ],
    groups: [{ group: "On the line", items: own }],
  });
}
