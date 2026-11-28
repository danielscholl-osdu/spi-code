// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  fleetLines,
  type TodayFleet,
  type TodayLine,
  type TodayMemberStation,
} from "@spi-code/contracts";
import { FORKS, type Route, routeHash } from "../../app/navigation.js";
import { when } from "../../time.js";

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

const and = (words: readonly string[]) =>
  words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : (words[0] ?? "");

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

/** What a cell's ⌀ names: "Sync PRs not read on indexer and search". */
const GAP_NOUNS: Readonly<Record<StationFigure["id"] | DoorFigure["id"] | "environment", string>> =
  {
    upstream: "Upstream",
    sync: "Sync PRs",
    integration: "Integration PRs",
    main: "Main runs",
    template: "Template PRs",
    release: "Release PRs",
    dependabot: "Dependabot PRs",
    other: "Other PRs",
    environment: "Deployments",
  };

/** The four marks: a filter, a link, plain text, the known-empty dot and not read. */
export type CellKind = "filter" | "link" | "plain" | "dot" | "not-read";

export type FlowCell = {
  id: StationFigure["id"] | DoorFigure["id"] | "environment";
  label: string;
  kind: CellKind;
  tone?: "error" | "warning";
  value?: string;
  /** Muted after the value on its line: "· 18:00", "· 6 red". */
  more?: string;
  /** The readout's second line on Main and Environment. */
  sub?: string;
  tick?: boolean;
  /** Main's red count, in red. */
  bad?: boolean;
  title?: string;
  pressed?: boolean;
  open?: () => void;
  href?: string;
  /** The Can wait row a door's value opens. */
  target?: string;
  /** The ⌀ › chip's title on a cell with a value and a gap; the chip opens Evidence. */
  gap?: string;
};

export type FleetCells = {
  label: string;
  stations: FlowCell[];
  doors: FlowCell[];
  main: FlowCell;
  environment: FlowCell;
  notRead: readonly string[];
};

const EVIDENCE = routeHash({ kind: "evidence" });
const TODAY = routeHash({ kind: "today" });

/** Where a value's › goes, with the words its hover adds. */
type Link = { open: () => void; href: string; says: string };

const withTitle = (title: string | undefined, says: string) => (title ? `${title}\n${says}` : says);

type Open = {
  filter(station: TodayMemberStation): void;
  cause(row: string): void;
  upstream(): void;
  forks(): void;
  environment(): void;
  evidence(): void;
};

/** Red when the cell holds a Blocked row, amber when it holds a Waiting on you row. */
function toneOf(held: readonly TodayLine[]) {
  return held.some(({ section }) => section === "blocked")
    ? ("error" as const)
    : held.length
      ? ("warning" as const)
      : undefined;
}

function heldWord(held: readonly TodayLine[], tone: "error" | "warning") {
  const members = new Set(held.flatMap(({ members }) => members.map(({ id }) => id))).size;
  return `${members} ${tone === "error" ? "blocked" : "waiting"}`;
}

/** A figure's cell: a filter when tinted, else its value as a link or plain text, else a dot or ⌀. */
function cell(
  base: Pick<FlowCell, "id" | "label" | "title" | "more" | "target">,
  figure: { notRead: readonly string[] },
  value: string | undefined,
  held: readonly TodayLine[],
  filter: TodayMemberStation | undefined,
  pressed: TodayMemberStation | undefined,
  link: Link | undefined,
  on: Open,
): FlowCell {
  const gap = figure.notRead.length
    ? `${GAP_NOUNS[base.id]} not read on ${and(figure.notRead)}`
    : undefined;
  const tone = filter ? toneOf(held) : undefined;
  if (tone && filter) {
    const on_ = pressed === filter;
    return {
      ...base,
      kind: "filter",
      tone,
      value: value ?? heldWord(held, tone),
      pressed: on_,
      open: () => on.filter(filter),
      ...(on_ ? { title: withTitle(base.title, "Press again to show all") } : {}),
      ...(gap ? { gap } : {}),
    };
  }
  if (value)
    return {
      ...base,
      kind: link ? "link" : "plain",
      value,
      ...(link
        ? { open: link.open, href: link.href, title: withTitle(base.title, link.says) }
        : {}),
      ...(gap ? { gap } : {}),
    };
  const { more: _more, ...rest } = base;
  return gap ? { ...rest, ...unread(gap, on) } : { ...rest, kind: "dot" };
}

function unread(gap: string, on: Open) {
  return {
    kind: "not-read" as const,
    title: `${gap} · opens Evidence`,
    open: on.evidence,
    href: EVIDENCE,
  };
}

function stationValue(figure: StationFigure): Pick<FlowCell, "value" | "more"> {
  switch (figure.id) {
    case "upstream": {
      const behind = figure.behind?.length ?? 0;
      if (figure.stopped.length) return { value: `${forksWord(figure.stopped.length)} stopped` };
      return behind ? { value: `${forksWord(behind)} behind` } : {};
    }
    case "sync":
      return figure.count ? { value: `${figure.count} open` } : {};
    default: {
      const cascade = cascadeWaits(figure).length;
      if (!figure.count) return cascade ? { value: `${cascade} waiting for cascade` } : {};
      return {
        value: plural(figure.count, "PR"),
        ...(figure.red.length ? { more: `· ${figure.red.length} red` } : {}),
      };
    }
  }
}

/** Main as a readout: green only when every fork was read green. */
function mainCell(figure: StationFigure, forks: number, on: Open): FlowCell {
  const base = {
    id: figure.id,
    label: STATION_LABELS.main,
    ...titled(figure),
  };
  const gap = figure.notRead.length
    ? `${GAP_NOUNS.main} not read on ${and(figure.notRead)}`
    : undefined;
  if (figure.stopped.length)
    return {
      ...base,
      kind: "plain",
      value: `${figure.stopped.length} red`,
      bad: true,
      ...(figure.count ? { sub: `${figure.count} green` } : {}),
      ...(gap ? { gap } : {}),
    };
  if (forks && figure.count === forks && !gap)
    return { ...base, kind: "plain", value: "Green", tick: true, sub: forksWord(forks) };
  if (figure.count)
    return { ...base, kind: "plain", value: `${figure.count} green`, ...(gap ? { gap } : {}) };
  return gap ? { ...base, ...unread(gap, on) } : { ...base, kind: "dot" };
}

function titled(figure: StationFigure) {
  const title = forksTitle([
    [COUNTED[figure.id], figure.forks],
    ["Behind", figure.behind],
    ["Stopped", figure.stopped],
    ["Red", figure.red],
    ["Running", figure.inProgress],
    ["Waiting on you", figure.waitingOnPerson],
    ["Waiting on time", figure.waitingOnClock],
    ["Not read", figure.notRead],
  ]);
  return title ? { title } : {};
}

function environmentCell(fleet: TodayFleet, on: Open): FlowCell {
  const { state, version, lanes, notRead } = fleet.environment;
  const base = { id: "environment" as const, label: "Environment" };
  if (state === "unread") return { ...base, ...unread("Readiness not read", on) };
  const sub = [version, lanes ? `${plural(lanes, "lane")} busy` : undefined]
    .filter(Boolean)
    .join(" · ");
  return {
    ...base,
    kind: "link",
    value: state === "ready" ? "Ready" : "Maintenance",
    tick: state === "ready",
    title: "Opens Environment",
    open: on.environment,
    href: routeHash({ kind: "environment" }),
    ...(sub ? { sub } : {}),
    ...(notRead.length ? { gap: `${GAP_NOUNS.environment} not read on ${and(notRead)}` } : {}),
  };
}

const link = (route: Route, open: () => void, says: string): Link => ({
  open,
  href: routeHash(route),
  says,
});

/**
 * Today's flow from core's fleet figures. A cell is tinted only when it holds a row of Yours;
 * Upstream, Sync PR, Integration and Template then toggle their filter.
 */
export function fleetCells(
  fleet: TodayFleet,
  lines: readonly TodayLine[],
  pressed: TodayMemberStation | undefined,
  on: Open,
): FleetCells {
  const forks = fleet.forks.yours.length + fleet.forks.rest.forks.length;
  const nextSync = fleet.nextSyncAt ? `· ${when(fleet.nextSyncAt)}` : undefined;
  const stations = fleet.stations.flatMap((figure): FlowCell[] => {
    if (figure.id === "main") return [];
    const { value, more } = stationValue(figure);
    const behind = figure.id === "upstream" && !figure.stopped.length && value;
    return [
      cell(
        {
          id: figure.id,
          label: STATION_LABELS[figure.id],
          ...titled(figure),
          ...(more ? { more } : behind && nextSync ? { more: nextSync } : {}),
        },
        figure,
        value,
        fleetLines(lines, figure.id),
        figure.id,
        pressed,
        figure.id === "upstream"
          ? link({ kind: "upstream" }, on.upstream, "Opens Upstream")
          : figure.id === "sync"
            ? link(FORKS, on.forks, "Opens Forks")
            : undefined,
        on,
      ),
    ];
  });
  const doors = fleet.doors.map((figure) => {
    const { target } = figure;
    const title = forksTitle([
      ["Open", figure.forks],
      ["Not read", figure.notRead],
    ]);
    const value = figure.count
      ? figure.id === "template"
        ? `${figure.count} to review`
        : `${figure.count} open`
      : undefined;
    return cell(
      {
        id: figure.id,
        label: DOOR_LABELS[figure.id],
        ...(title ? { title } : {}),
        ...(target?.kind === "cause" ? { target: target.row } : {}),
      },
      figure,
      value,
      figure.id === "template" ? fleetLines(lines, "template") : [],
      figure.id === "template" ? "template" : undefined,
      pressed,
      target?.kind === "cause"
        ? {
            open: () => on.cause(target.row),
            href: TODAY,
            says: `Shows the ${DOOR_LABELS[figure.id]} row in Can wait`,
          }
        : undefined,
      on,
    );
  });
  const main = fleet.stations.find(({ id }) => id === "main");
  return {
    label: `How code is reaching main across the ${forksWord(forks)}`,
    stations,
    doors,
    main: main
      ? mainCell(main, forks, on)
      : { id: "main", label: STATION_LABELS.main, kind: "dot" },
    environment: environmentCell(fleet, on),
    notRead: fleet.notRead,
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
