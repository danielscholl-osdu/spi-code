// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";
import type { Route } from "../app/routes.js";
import { inspectId } from "../views/environment/timeline.js";

export type SelectionKind =
  | "queue"
  | "flow"
  | "plan"
  | "repository"
  | "repository-line"
  | "template-step"
  | "theme"
  | "environment"
  | "release"
  | "station";

/**
 * Lists pass a row to select(id, row), or use useSelectionList in displayed order.
 * The id is stable across routes; inspectId overrides it for stations (null means row-only).
 * Fields are the row's own reading, not a second inspector. Omit them when inspect carries it all.
 */
export type SelectionRow = {
  id: string;
  title: string;
  kind: SelectionKind;
  inspectId?: string | null;
  fields?: readonly { label: string; value: string }[];
  /** Snapshot JSON pointers feeding this row, for the selection's evidence chip/tab. */
  prefixes?: readonly string[];
};

const stationLabels = {
  upstream: "Upstream",
  sync: "Sync PR",
  cascade: "Cascade",
  main: "Sync to main",
  release: "Release",
  lane: "Stack lane",
};

/** Snapshot rows for title/field lookup, including existing callers that select only an id. */
export function selectionRows(snapshot: ViewSnapshot): SelectionRow[] {
  const { briefing, releases } = snapshot;
  return [
    ...[...briefing.focus, ...briefing.rest].map(
      (item, index): SelectionRow => ({
        id: item.id,
        title: item.title,
        kind: "queue",
        prefixes: [
          index < briefing.focus.length
            ? `/briefing/focus/${index}`
            : `/briefing/rest/${index - briefing.focus.length}`,
        ],
      }),
    ),
    ...briefing.flow.rows.map(
      (row, index): SelectionRow => ({
        id: row.inspect,
        title: row.detail.title || row.fork,
        kind: "flow",
        prefixes: [`/briefing/flow/rows/${index}`],
        fields: [
          { label: "Behind", value: row.behind },
          { label: "Carries", value: row.carries },
          { label: "Ready", value: row.ready.text },
          { label: "Plan", value: row.plan.text },
          ...row.line.map((cell, index) => ({
            label: ["Sync PR", "Cascade", "Sync to main", "Main run"][index] ?? "Line",
            value: cell.text,
          })),
          { label: "Next", value: row.next.text },
          ...row.detail.lines.map((value) => ({ label: "Detail", value })),
        ],
      }),
    ),
    {
      id: briefing.flow.inspect,
      title: briefing.flow.plan.title,
      kind: "plan",
      prefixes: ["/briefing/flow/plan", "/briefing/flow/schedule"],
      fields: [
        ...briefing.flow.plan.lines.map(({ label, text }) => ({ label, value: text })),
        { label: "Note", value: briefing.flow.plan.note },
        ...(briefing.flow.schedule
          ? [{ label: briefing.flow.schedule.title, value: briefing.flow.schedule.text }]
          : []),
      ],
    },
    ...briefing.repositories.rows.map(
      (row, index): SelectionRow => ({
        id: row.id,
        title: row.title,
        kind: "repository",
        prefixes: [`/briefing/repositories/rows/${index}`],
      }),
    ),
    ...briefing.repositories.rows.flatMap((repo, repoIndex) =>
      repo.sections.flatMap((section, sectionIndex) =>
        section.lines.flatMap((line, lineIndex): SelectionRow[] =>
          line.id
            ? [
                {
                  id: line.id,
                  title: line.text,
                  kind: "repository-line",
                  prefixes: [
                    `/briefing/repositories/rows/${repoIndex}/sections/${sectionIndex}/lines/${lineIndex}`,
                  ],
                },
              ]
            : [],
        ),
      ),
    ),
    ...briefing.themes.map(
      (theme, index): SelectionRow => ({
        id: theme.inspect ?? `theme:${theme.id}`,
        title: theme.title,
        kind: "theme",
        prefixes: [`/briefing/themes/${index}`],
      }),
    ),
    ...briefing.environment.lanes.flatMap((lane, laneIndex) =>
      lane.events.map(
        (event, index): SelectionRow => ({
          id: inspectId(lane, event),
          title: event.label,
          kind: "environment",
          prefixes: [`/briefing/environment/lanes/${laneIndex}/events/${index}`],
        }),
      ),
    ),
    ...releases.lines.map(
      (month, index): SelectionRow => ({
        id: month.id,
        title: month.name,
        kind: "release",
        prefixes: [`/releases/lines/${index}`],
      }),
    ),
    ...snapshot.stations.flatMap(({ service, stations }, serviceIndex) =>
      stations.map(
        (station, index): SelectionRow => ({
          id: `station:${service}:${station.id}`,
          inspectId:
            station.inspect ??
            (station.id === "release" || station.id === "lane" ? null : `upstream:${service}`),
          title: `${stationLabels[station.id]} · ${service}`,
          kind: "station",
          prefixes: [`/stations/${serviceIndex}/stations/${index}`],
          fields: [
            { label: "Station", value: stationLabels[station.id] },
            { label: "State", value: station.state },
            { label: "Reading", value: station.text },
          ],
        }),
      ),
    ),
  ];
}

/** Membership, not the current DOM, decides whether selection survives a route change. */
export function routeSelectionIds(snapshot: ViewSnapshot, route: Route): string[] {
  const { briefing } = snapshot;
  const queue = [...briefing.focus, ...briefing.rest];
  const repos = briefing.repositories.rows;
  switch (route.kind) {
    case "inbox":
      return queue.map(({ id }) => id);
    case "lens":
      if (route.lens === "flow")
        return [briefing.flow.inspect, ...briefing.flow.rows.map(({ inspect }) => inspect)];
      if (route.lens === "repositories") return repos.map(({ id }) => id);
      return briefing.themes.map((theme) => theme.inspect ?? `theme:${theme.id}`);
    case "service":
      return [
        ...queue.filter(({ scope }) => scope === route.id).map(({ id }) => id),
        ...briefing.flow.rows.filter(({ fork }) => fork === route.id).map(({ inspect }) => inspect),
        ...repos.filter(({ id }) => id === `repo:${route.id}`).map(({ id }) => id),
        ...briefing.themes
          .filter(
            (theme) =>
              [...theme.certain, ...theme.possible].some(({ fork }) => fork === route.id) ||
              theme.exposed.includes(route.id),
          )
          .map((theme) => theme.inspect ?? `theme:${theme.id}`),
        ...(snapshot.stations.find(({ service }) => service === route.id)?.stations ?? []).map(
          (station) => `station:${route.id}:${station.id}`,
        ),
      ];
    case "template":
      return [
        ...queue.filter(({ id }) => id === "rollout").map(({ id }) => id),
        ...repos.filter(({ name }) => name === "osdu-spi").map(({ id }) => id),
      ];
    case "environment":
      return [
        ...briefing.environment.lanes.flatMap((lane) =>
          lane.events.map((event) => inspectId(lane, event)),
        ),
        ...repos
          .filter(({ name }) => name === "osdu-spi-stack")
          .flatMap((repo) => [
            repo.id,
            ...repo.sections.flatMap((section) =>
              section.lines.flatMap((line) => (line.id ? [line.id] : [])),
            ),
          ]),
      ];
    case "releases":
      return snapshot.releases.lines.map(({ id }) => id);
    case "release":
      return snapshot.releases.lines
        .filter(({ month }) => month === route.month)
        .map(({ id }) => id);
    case "setup":
      return [];
  }
}
