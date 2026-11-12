// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Model } from "@spi-code/core";
import type { WatchInput } from "./project.js";
import type { RunHit } from "./recorded-runs.js";
import type { projectReleases } from "./releases.js";
import { serviceReleaseReadTimes } from "./service-release-reads.js";
import { stationSubstate } from "./substate.js";

export function projectStations(model: Model, input: WatchInput) {
  return model.lines.map((line) => ({
    service: line.fork.id,
    stations: line.stations.map((station) => ({
      ...station,
      substate: stationSubstate(station, line, input),
      inspect: `station:${line.fork.id}:${station.id}`,
    })),
  }));
}

export function projectServices(
  model: Model,
  input: WatchInput,
  runs: readonly RunHit[],
  documents: ReturnType<typeof projectReleases>["documents"],
  now: Date,
) {
  return model.lines.map((line) => ({
    service: line.fork.id,
    runs: runs
      .filter(({ repo }) => repo === line.fork.repo)
      .sort(
        (a, b) => Date.parse(b.run.createdAt) - Date.parse(a.run.createdAt) || b.run.id - a.run.id,
      )
      .map(({ run }) => ({
        id: `run:${run.id}`,
        workflow: run.name,
        result: run.status === "completed" ? (run.conclusion ?? "completed") : run.status,
        time: run.createdAt,
        ...(run.status === "completed" ? { completedAt: run.updatedAt } : {}),
        url: run.url,
      })),
    releases: documents.flatMap((doc) =>
      doc.rows
        .filter((row) => row.id === line.fork.id)
        .map((row) => {
          const gate = line.stations.find((station) => station.id === "release");
          const pr = line.releasePr?.pr;
          return {
            ...row,
            month: doc.month,
            readTimes: serviceReleaseReadTimes(line.fork.repo, input),
            ...(doc.month === now.toISOString().slice(0, 7)
              ? {
                  ...(gate ? { gate: { state: gate.state, text: gate.text } } : {}),
                  ...(pr ? { releasePr: { number: pr.number, title: pr.title, url: pr.url } } : {}),
                }
              : {}),
          };
        }),
    ),
  }));
}
