// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { CanWaitCauses, TodayFleet } from "@spi-code/contracts";
import type { ServiceHome } from "@spi-code/contracts";
import type { ForkDeployments } from "../model/index.js";
import type { UpFork } from "../model/upstream.js";
import type { Environment } from "./index.js";
import type { forkReads } from "./service-home.js";
import type { TodayLine } from "./lines.js";

type ForkHome = { service: string; home?: ServiceHome | undefined };
export type FleetReads = {
  upstream: readonly Pick<UpFork, "service" | "behind">[];
  deployments: readonly Pick<ForkDeployments, "fork" | "read">[];
  /** Per fork, whether each source its stations stand on was read. */
  sources: readonly ({ service: string } & ReturnType<typeof forkReads>)[];
};
const STATIONS = Object.freeze(["upstream", "sync", "integration", "main"] as const satisfies readonly TodayFleet["stations"][number]["id"][]);
const DOORS = Object.freeze(["template", "release", "dependabot", "other"] as const satisfies readonly TodayFleet["doors"][number]["id"][]);

function stationFigures(homes: readonly ForkHome[], upstream: FleetReads["upstream"]): TodayFleet["stations"] {
  return STATIONS.map((id) => {
    const readings = homes.map(({ service, home }) => ({
      service,
      station: home?.stations.find((station) => station.id === id),
    }));
    const stopped = readings.filter(({ station }) => station?.state === "stopped").map(({ service }) => service);
    const forks = id === "upstream" ? stopped : readings.filter(({ station }) =>
      id === "main" ? station?.state === "green" : station?.pr !== undefined,
    ).map(({ service }) => service);
    const cascadeWait = (state: "waiting-on-person" | "waiting-on-clock") =>
      readings.filter(({ station }) =>
        station?.state === state && !station.pr && station.nextAt,
      ).map(({ service }) => service);
    const notRead = readings.filter(({ station }) =>
      !station || station.state === "unread" || station.notRead,
    ).map(({ service }) => service);
    const behind = id === "upstream"
      ? readings.filter(({ service }) => !notRead.includes(service) &&
        (upstream.find((fork) => fork.service === service)?.behind ?? 0) > 0).map(({ service }) => service)
      : undefined;
    return {
      id, count: forks.length, forks, stopped,
      red: readings.filter(({ station }) => station?.state === "stopped" && station.pr).map(({ service }) => service),
      inProgress: readings.filter(({ station }) => station?.state === "in-progress").map(({ service }) => service),
      waitingOnPerson: id === "integration" ? cascadeWait("waiting-on-person") : [],
      waitingOnClock: id === "integration" ? cascadeWait("waiting-on-clock") : [],
      notRead,
      ...(behind ? { behind } : {}),
    };
  });
}

const and = (words: readonly string[]) =>
  words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : (words[0] ?? "");

type Source = "upstream" | "pulls" | "runs";
const SOURCE_NAMES: Readonly<Record<Source, string>> = Object.freeze({ upstream: "upstream", pulls: "pull requests", runs: "runs" });
type FigureId = TodayFleet["stations"][number]["id"] | TodayFleet["doors"][number]["id"];
const FIGURE_NAMES: Readonly<Record<FigureId, string>> = Object.freeze({
  upstream: "Upstream", sync: "Sync PR", integration: "Integration", main: "Main",
  template: "Template PRs", release: "Release PRs", dependabot: "Dependabot PRs", other: "Other PRs",
});
// The sources a station's or door's reading stands on; a gap no failed source explains names the figure.
const STANDS_ON: Readonly<Record<FigureId, readonly Source[]>> = Object.freeze({
  upstream: ["upstream", "pulls", "runs"], sync: ["pulls", "runs"], integration: ["pulls", "runs"], main: ["runs"],
  template: ["pulls"], release: ["pulls"], dependabot: ["pulls"], other: ["pulls"],
});

/** One name per fork for what the flow did not read on it, each source named once, in fleet order. */
function notReadNames(
  forks: readonly string[],
  stations: TodayFleet["stations"],
  doors: TodayFleet["doors"],
  sources: FleetReads["sources"],
  deployments: readonly string[],
): string[] {
  return [...new Set([...forks, ...deployments])].flatMap((fork) => {
    const read = sources.find(({ service }) => service === fork);
    const failed = forks.includes(fork) && read
      ? (Object.keys(SOURCE_NAMES) as Source[]).filter((source) => !read[source])
      : [];
    const unexplained = [...stations, ...doors]
      .filter(({ id, notRead }) => notRead.includes(fork) && !STANDS_ON[id].some((source) => failed.includes(source)))
      .map(({ id }) => FIGURE_NAMES[id]);
    const nouns = [
      ...failed.map((source) => SOURCE_NAMES[source]),
      ...unexplained,
      ...(deployments.includes(fork) ? ["deployment"] : []),
    ];
    return nouns.length ? [`${fork}'s ${and(nouns)}`] : [];
  });
}

function doorFigures(homes: readonly ForkHome[]): TodayFleet["doors"] {
  return DOORS.map((id) => {
    const readings = homes.map(({ service, home }) => ({
      service,
      door: home?.doors.find((door) => door.id === id),
    }));
    const known = readings.map(({ service, door }) => ({ service, count: door?.count ?? door?.prs.length ?? 0 }));
    return {
      id,
      count: known.reduce((sum, entry) => sum + entry.count, 0),
      forks: known.filter(({ count }) => count > 0).map(({ service }) => service),
      notRead: readings.filter(({ door }) => door?.count == null).map(({ service }) => service),
    };
  });
}

export function todayFleet(
  homes: readonly ForkHome[],
  environment: Environment,
  nextSyncAt: string | undefined,
  causes: CanWaitCauses,
  lines: readonly TodayLine[],
  reads: FleetReads,
): TodayFleet {
  const stations = stationFigures(homes, reads.upstream);
  const templateHeld = lines.some(({ members }) => members.some(({ station }) => station === "template"));
  const doors = doorFigures(homes).map((door) => {
    if (door.id === "template" && (door.count || templateHeld))
      return { ...door, target: { kind: "station", station: "template" } as const };
    if (!door.count) return door;
    // Causes are already ordered by descending breadth within the cross-fork rows.
    const cause = causes.rows.find(({ kind, forkCount }) => kind === door.id && (kind !== "other" || forkCount > 0));
    return cause ? { ...door, target: { kind: "cause", row: cause.id } as const } : door;
  });
  const yours = homes.filter(({ home }) => home?.mark.kind === "count");
  const rest = homes.filter(({ home }) => home?.mark.kind !== "count");
  const stopped = new Set(stations.flatMap((station) => station.stopped));
  const version = environment.facts.find(({ label }) => label === "Running")?.figure;
  const unread = reads.deployments.filter(({ read }) => read === "unread").map(({ fork }) => fork);
  const status = environment.status;
  const lanes = status?.state === "in-use" ? status.live?.length
    : status?.state === "idle" ? 0 : undefined;
  return {
    stations, doors, nextSyncAt,
    environment: {
      state: environment.deployable === "yes" ? "ready" :
        environment.deployable === "no" ? "maintenance" : "unread",
      ...(version && version !== "?" ? { version } : {}),
      ...(lanes !== undefined ? { lanes } : {}),
      notRead: unread,
    },
    notRead: notReadNames(homes.map(({ service }) => service), stations, doors, reads.sources, unread),
    forks: {
      yours: yours.map(({ service }) => service),
      stopped: homes.filter(({ service }) => stopped.has(service)).map(({ service }) => service),
      rest: {
        forks: rest.map(({ service }) => service),
        stations: stationFigures(rest, reads.upstream),
        doors: doorFigures(rest),
      },
    },
  };
}
