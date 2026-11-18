// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  fleetLines,
  type TodayFleet,
  type TodayLine,
  type TodayMemberStation,
} from "@spi-code/contracts";
import type { FlowDoor, FlowState, FlowStation } from "../../components/flow/Flow.js";
import { clockTime } from "../../time.js";

type StationFigure = TodayFleet["stations"][number];
type DoorFigure = TodayFleet["doors"][number];

export const FILTER_NAMES: Readonly<Record<TodayMemberStation, string>> = {
  upstream: "Upstream",
  sync: "Sync PR",
  integration: "Integration",
  template: "Template",
};

export const STATION_LABELS: Readonly<Record<StationFigure["id"], string>> = {
  upstream: "Upstream",
  sync: "Sync PR",
  integration: "Integration",
  main: "Main",
};

const DOOR_LABELS: Readonly<Record<DoorFigure["id"], string>> = {
  template: "Template",
  release: "Release",
  dependabot: "Dependabot",
  other: "Other PRs",
};

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** A known count keeps showing; a missing read adds ⌀, and an empty figure with one is not read. */
function figureWord(figure: { count: number; notRead: readonly string[] }, known: string): string {
  if (figure.notRead.length === 0) return known;
  return figure.count > 0 ? `${known} ⌀` : "⌀ not read";
}

/** The worst state among a station's forks, and a waiting row of yours makes it waiting on you. */
function stationState(figure: StationFigure, held: TodayLine[]): FlowState {
  if (figure.stopped.length || held.some(({ section }) => section === "blocked")) return "stopped";
  if (figure.waitingOnPerson.length || held.length) return "waiting-on-person";
  if (figure.inProgress.length) return "in-progress";
  if (figure.waitingOnClock.length) return "waiting-on-clock";
  if (figure.notRead.length && figure.count === 0) return "unread";
  return "ready";
}

function stationWords(figure: StationFigure, nextSyncAt: string | undefined) {
  switch (figure.id) {
    case "upstream":
      return {
        word: figureWord(figure, figure.count ? `${figure.count} stopped` : "Sync current"),
        line: nextSyncAt ? `next sync ${clockTime(nextSyncAt, { hint: false })}` : undefined,
      };
    case "main":
      return {
        word: figureWord(figure, `${figure.count} green`),
        line: joined([
          figure.stopped.length && `${figure.stopped.length} red`,
          figure.inProgress.length && `${figure.inProgress.length} running`,
        ]),
      };
    default: {
      const red = figure.red.length;
      const cascade = cascadeWaits(figure).length;
      return {
        word: figureWord(figure, figure.count ? `${figure.count} open` : "None open"),
        line: joined([
          red &&
            (red === figure.count && red > 1 ? (red === 2 ? "both red" : "all red") : `${red} red`),
          figure.id === "integration" && cascade && `${cascade} waiting for cascade`,
        ]),
      };
    }
  }
}

const joined = (parts: readonly (string | false | 0)[]) =>
  parts.filter(Boolean).join(" · ") || undefined;

/** Forks whose sync merged and whose cascade has not yet opened an integration PR. */
export const cascadeWaits = (figure: StationFigure) => [
  ...figure.waitingOnPerson,
  ...figure.waitingOnClock,
];

/** Each fork list a figure holds, one line per state, for the figure's hover. */
function forksTitle(lists: readonly [string, readonly string[] | undefined][]): string | undefined {
  const named = lists.flatMap(([word, forks]) =>
    forks?.length ? [`${word}: ${forks.join(", ")}`] : [],
  );
  return named.length ? [...new Set(named)].join("\n") : undefined;
}

const COUNTED: Readonly<Record<StationFigure["id"], string>> = {
  upstream: "Stopped",
  sync: "Open",
  integration: "Open",
  main: "Green",
};

export type FleetFlow = {
  stations: FlowStation[];
  doors: FlowDoor[];
  environment: FlowStation;
};

/**
 * Today's flow from core's fleet figures. Upstream, Sync PR, Integration and a Template door with
 * a target toggle their filter; the other doors open the Can wait row core names.
 */
export function fleetFlow(
  fleet: TodayFleet,
  lines: readonly TodayLine[],
  pressed: TodayMemberStation | undefined,
  on: {
    filter(station: TodayMemberStation): void;
    cause(row: string): void;
    environment(): void;
  },
): FleetFlow {
  const forks = fleet.forks.yours.length + fleet.forks.rest.forks.length;
  const stations = fleet.stations.map((figure): FlowStation => {
    const filter = figure.id === "main" ? undefined : figure.id;
    return {
      id: figure.id,
      label: STATION_LABELS[figure.id],
      state:
        figure.id === "main"
          ? figure.stopped.length
            ? "stopped"
            : figure.count === forks && !figure.notRead.length
              ? "green"
              : figure.notRead.length && !figure.count
                ? "unread"
                : "ready"
          : stationState(figure, filter ? fleetLines(lines, filter) : []),
      ...stationWords(figure, fleet.nextSyncAt),
      title: forksTitle([
        [COUNTED[figure.id], figure.forks],
        ["Stopped", figure.stopped],
        ["Running", figure.inProgress],
        ["Waiting on you", figure.waitingOnPerson],
        ["Waiting on time", figure.waitingOnClock],
        ["Not read", figure.notRead],
      ]),
      ...(filter ? { onOpen: () => on.filter(filter), pressed: pressed === filter } : {}),
    };
  });
  const doors = fleet.doors.map((figure): FlowDoor => {
    const known = figure.count
      ? figure.id === "template"
        ? `${figure.count} to review`
        : `${figure.count} open`
      : figure.id === "template"
        ? "None to review"
        : "None open";
    const target = figure.target;
    return {
      id: figure.id,
      label: DOOR_LABELS[figure.id],
      word: figureWord(figure, known),
      title: forksTitle([
        ["Open", figure.forks],
        ["Not read", figure.notRead],
      ]),
      ...(target ? { target: target.kind === "station" ? target.station : target.row } : {}),
      ...(target?.kind === "station"
        ? { onOpen: () => on.filter(target.station), pressed: pressed === target.station }
        : target?.kind === "cause"
          ? { onOpen: () => on.cause(target.row) }
          : {}),
    };
  });
  const { state, version } = fleet.environment;
  return {
    stations,
    doors,
    environment: {
      id: "environment",
      label: "Environment",
      state: state === "ready" ? "green" : state === "maintenance" ? "stopped" : "unread",
      word: state === "ready" ? "Ready" : state === "maintenance" ? "Maintenance" : "⌀ not read",
      line: version,
      onOpen: on.environment,
    },
  };
}

/**
 * What Yours names while a filter is on: the figure's not-read forks, and on Integration the forks
 * waiting for their cascade, which wait on no one and so have no row.
 */
export function filterFigure(
  fleet: TodayFleet | undefined,
  station: TodayMemberStation,
): { notRead: readonly string[]; cascade: readonly string[] } {
  if (station === "template") {
    const door = fleet?.doors.find(({ id }) => id === "template");
    return { notRead: door?.notRead ?? [], cascade: [] };
  }
  const figure = fleet?.stations.find(({ id }) => id === station);
  return {
    notRead: figure?.notRead ?? [],
    cascade: figure && station === "integration" ? cascadeWaits(figure) : [],
  };
}

export const forksWord = (count: number) => plural(count, "fork");
