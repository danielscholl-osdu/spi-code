// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { CanWaitCauses, TodayFleet } from "@spi-code/contracts";
import type { ServiceHome } from "@spi-code/contracts";
import type { Environment } from "./index.js";

type ForkHome = { service: string; home?: ServiceHome | undefined };
const STATIONS = Object.freeze(["upstream", "sync", "integration", "main"] as const satisfies readonly TodayFleet["stations"][number]["id"][]);
const DOORS = Object.freeze(["template", "release", "dependabot", "other"] as const satisfies readonly TodayFleet["doors"][number]["id"][]);

function stationFigures(homes: readonly ForkHome[]): TodayFleet["stations"] {
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
    return {
      id, count: forks.length, forks, stopped,
      inProgress: readings.filter(({ station }) => station?.state === "in-progress").map(({ service }) => service),
      waitingOnPerson: id === "integration" ? cascadeWait("waiting-on-person") : [],
      waitingOnClock: id === "integration" ? cascadeWait("waiting-on-clock") : [],
      notRead: readings.filter(({ station }) =>
        !station || station.state === "unread" || station.notRead,
      ).map(({ service }) => service),
    };
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
): TodayFleet {
  const stations = stationFigures(homes);
  const doors = doorFigures(homes).map((door) => {
    if (!door.count) return door;
    if (door.id === "template") return { ...door, target: { kind: "station", station: "template" } as const };
    // Causes are already ordered by descending breadth within the cross-fork rows.
    const cause = causes.rows.find(({ kind, forkCount }) => kind === door.id && (kind !== "other" || forkCount > 0));
    return cause ? { ...door, target: { kind: "cause", row: cause.id } as const } : door;
  });
  const yours = homes.filter(({ home }) => home?.mark.kind === "count");
  const rest = homes.filter(({ home }) => home?.mark.kind !== "count");
  const stopped = new Set(stations.flatMap((station) => station.stopped));
  const version = environment.facts.find(({ label }) => label === "Running")?.figure;
  return {
    stations, doors, nextSyncAt,
    environment: {
      state: environment.deployable === "yes" ? "ready" :
        environment.deployable === "no" ? "maintenance" : "unread",
      ...(version && version !== "?" ? { version } : {}),
    },
    forks: {
      yours: yours.map(({ service }) => service),
      stopped: homes.filter(({ service }) => stopped.has(service)).map(({ service }) => service),
      rest: { forks: rest.map(({ service }) => service), stations: stationFigures(rest), doors: doorFigures(rest) },
    },
  };
}
