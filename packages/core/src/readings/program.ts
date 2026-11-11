// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Facts } from "../facts.js";
import type { Model } from "../model/index.js";
import { stationSubstateOf } from "../model/substate.js";
import { type PlaceReading, placeReading, type ReadingItem } from "./index.js";

export interface ProgramReadingInput<T extends ReadingItem> {
  model: Model;
  facts: Pick<Facts, "approvals" | "runs" | "radar">;
  items: readonly T[];
}

export function programReading<T extends ReadingItem>(input: ProgramReadingInput<T>): PlaceReading<T> {
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
  const headline = [
    stopped.length ? `Stopped: ${stopped.join(", ")}.` : undefined,
    lanes.length ? `Failed lanes: ${lanes.join(", ")}.` : undefined,
  ].filter(Boolean).join(" ") || (stoppedForks > 0
    ? "Fork lanes are blocked by the environment."
    : waiting.length ? `Waiting on people: ${waiting.join(", ")}.`
      : unread ? "Some fork stations are not read yet." : "No fork stations are stopped.");
  return placeReading({
    membership: true,
    headline,
    ...(unread ? { qualifier: `${unread} forks' repository stations not read yet.` } : {}),
    tiles: [
      { label: "Line", value: unread === model.lines.length ? "not read yet" : `${unread > 0 ? "At least " : ""}${stoppedForks} of ${model.lines.length}`, counts: "forks stopped" },
      { label: "Lanes", value: String(lanes.length), counts: "failed fork lanes" },
      { label: "Read", value: `${model.lines.length - unread} of ${model.lines.length}`, counts: "fork repositories read" },
    ],
    groups: [{ group: "On the line", items: own }],
  });
}
