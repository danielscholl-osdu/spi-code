// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ReleasesPane } from "@spi-code/contracts";
import { type Model, releasesToday, serviceHome } from "@spi-code/core";
import type { ProjectedBriefing } from "./briefing.js";
import type { WatchInput } from "./project.js";
import { releaseProvenance } from "./provenance.js";
import type { RunHit } from "./recorded-runs.js";
import type { projectReleases } from "./releases.js";
import { serviceReleaseReadTimes } from "./service-release-reads.js";
import { projectServiceRuns } from "./service-runs.js";
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
  briefing: ProjectedBriefing,
  pane: ReturnType<typeof projectReleases>["pane"],
) {
  const services = model.lines.map((line) => ({
    service: line.fork.id,
    ...projectServiceRuns(input.facts, line.fork.repo),
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
  const releases: NonNullable<ReleasesPane["today"]> = releasesToday({
    services,
    documents,
    facts: input.facts,
    context: input.context,
    provenance: releaseProvenance(pane.lines, input.releaseRecords, now),
  });
  const homes = serviceHome({
    model,
    facts: input.facts,
    reads: input.reads,
    now,
    lines: briefing.lines,
    items: [...briefing.focus, ...briefing.rest],
    canWait: briefing.today.canWait,
    versions: releases.versions,
  });
  return {
    services: services.map((service) => {
      const home = homes.get(service.service);
      return home ? { ...service, home } : service;
    }),
    releases,
  };
}
