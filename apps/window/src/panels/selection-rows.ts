// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { CanWait, Forming, ReleaseVersion, RepoLine, ViewSnapshot } from "@spi-code/contracts";
import type { Route } from "../app/routes.js";
import { clockTime } from "../time.js";
import { inspectId } from "../views/environment/timeline.js";
import { upstreamItemRows, upstreamSelectionIds } from "../views/upstream/reading.js";

export type SelectionKind =
  | "queue"
  | "flow"
  | "plan"
  | "repository"
  | "repository-line"
  | "run"
  | "template-step"
  | "theme"
  | "environment"
  | "release"
  | "station"
  | "can-wait"
  | "today-more"
  | "release-version"
  | "release-pr"
  | "release-notable";

/**
 * Lists pass a row to select(id, row), or use useSelectionList in displayed order.
 * The id is stable across routes; inspectId overrides it for stations (null means row-only).
 * Fields are the row's own reading, not a second inspector. Omit them when inspect carries it all.
 */
export type SelectionField = {
  label: string;
  value: string;
  /** A URL the snapshot carries, opened outside the app; never one the window builds. */
  href?: string;
  /** The machine-readable instant behind a time value. */
  dateTime?: string;
};

export type SelectionRow = {
  id: string;
  title: string;
  kind: SelectionKind;
  inspectId?: string | null;
  fields?: readonly SelectionField[];
  entries?: readonly { title: string; itemIds: readonly string[] }[];
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

export const repositoryLinePointer = (repoIndex: number, sectionIndex: number, lineIndex: number) =>
  `/briefing/repositories/rows/${repoIndex}/sections/${sectionIndex}/lines/${lineIndex}`;

/** The one selection row for a repository line, wherever it is drawn; a line without an id has none. */
export function repositoryLineRow(
  line: RepoLine,
  repoIndex: number,
  sectionIndex: number,
  lineIndex: number,
): SelectionRow | undefined {
  if (!line.id) return undefined;
  return {
    id: line.id,
    title: line.text,
    kind: "repository-line",
    prefixes: [repositoryLinePointer(repoIndex, sectionIndex, lineIndex)],
    fields: [
      ...(line.tag ? [{ label: "Tag", value: line.tag }] : []),
      ...(line.sub ? [{ label: "Reading", value: line.sub }] : []),
      { label: "Id", value: line.id },
      ...(line.url ? [{ label: "Link", value: line.url, href: line.url }] : []),
    ],
  };
}

export const CAN_WAIT_ID = "can-wait";

/** Today's Can wait list: each item core says can wait, with why; the host has nothing to add. */
export function canWaitRow(canWait: CanWait): SelectionRow {
  return {
    id: CAN_WAIT_ID,
    title: "Can wait",
    kind: "can-wait",
    inspectId: null,
    prefixes: ["/briefing/canWait"],
    fields: canWait.items.map(({ service, text, why }) => ({ label: service ?? text, value: why })),
  };
}

export const TODAY_GROUPS = ["decisions", "failing", "horizon", "motion"] as const;
export type TodayGroup = (typeof TODAY_GROUPS)[number];

/** Full lists use core's membership and wording, including lines joining several items. */
export function todayGroupRow(snapshot: ViewSnapshot, group: TodayGroup): SelectionRow {
  const { briefing } = snapshot;
  const lists = {
    decisions: {
      title: "Decisions waiting",
      rows: briefing.decisions?.groups ?? [],
      prefix: "/briefing/decisions",
    },
    failing: {
      title: "Failing",
      rows: briefing.ambient?.failing.lines ?? [],
      prefix: "/briefing/ambient/failing",
    },
    horizon: {
      title: "On the horizon",
      rows: briefing.horizon.cards ?? [],
      prefix: "/briefing/horizon/cards",
    },
    motion: {
      title: "In motion",
      rows: briefing.ambient?.inProgress.lines ?? [],
      prefix: "/briefing/ambient/inProgress",
    },
  };
  const list = lists[group];
  return {
    id: `today-more:${group}`,
    title: list.title,
    kind: "today-more",
    inspectId: null,
    prefixes: [list.prefix],
    entries: list.rows.map(({ text, itemIds }) => ({ title: text, itemIds })),
  };
}

type Released = Extract<ReleaseVersion, { state: "released" }>;
type Notable = Forming["notable"][number];
const prField = (pr: { number: number; url?: string | undefined }) => ({
  label: "Release PR",
  value: `#${pr.number}`,
  ...(pr.url ? { href: pr.url } : {}),
});

/** A service's released version on Today, with its open release PR when there is one. */
export function releaseVersionRow(version: Released, index: number): SelectionRow {
  return {
    id: `release:${version.service}`,
    title: `${version.service} ${version.released}`,
    kind: "release-version",
    inspectId: null,
    prefixes: [`/releases/today/versions/${index}`],
    fields: [
      { label: "Released", value: version.released },
      ...(version.proposed ? [{ label: "Proposed", value: version.proposed }] : []),
      ...(version.pr ? [prField(version.pr)] : []),
      ...(version.coreLibAzure ? [{ label: "core-lib-azure", value: version.coreLibAzure }] : []),
    ],
  };
}

/** A service's open release PR on Today: the version it proposes and what its body carries. */
export function releasePrRow(
  version: Released & { pr: NonNullable<Released["pr"]> },
  index: number,
  forming: Forming | undefined,
): SelectionRow {
  const body = forming?.prs.find(
    (release) => release.kind === "service" && release.service === version.service,
  );
  return {
    id: `release-pr:${version.service}`,
    title: `${version.service} release PR #${version.pr.number}`,
    kind: "release-pr",
    inspectId: version.pr.inspect ?? null,
    prefixes: [`/releases/today/versions/${index}`, "/releases/forming"],
    fields: [
      ...(version.proposed ? [{ label: "Proposes", value: version.proposed }] : []),
      { label: "Released", value: version.released },
      ...(version.pr.url ? [{ label: "Link", value: version.pr.url, href: version.pr.url }] : []),
      ...(body?.state === "read"
        ? body.entries.map(({ kind, title }) => ({ label: kind, value: title }))
        : body
          ? [{ label: "Changes", value: "not read" }]
          : []),
    ],
  };
}

/** One of the forming releases' notable changes, with the release PR that carries it. */
export function notableRow(notable: Notable, index: number): SelectionRow {
  return {
    id: `release-notable:${index}`,
    title: notable.title,
    kind: "release-notable",
    inspectId: notable.pr.inspect ?? null,
    prefixes: [`/releases/forming/notable/${index}`],
    fields: [
      { label: "Kind", value: notable.kind },
      { label: "Reaches", value: notable.text },
      prField(notable.pr),
    ],
  };
}

/** Today's Releases block rows: each released version, each open release PR, each notable change. */
export function releaseRows({ releases }: Pick<ViewSnapshot, "releases">): SelectionRow[] {
  const versions = releases.today?.versions ?? [];
  return [
    ...versions.flatMap((version, index) =>
      version.state === "released" ? [releaseVersionRow(version, index)] : [],
    ),
    ...versions.flatMap((version, index) =>
      version.state === "released" && version.pr
        ? [releasePrRow({ ...version, pr: version.pr }, index, releases.forming)]
        : [],
    ),
    ...(releases.forming?.notable ?? []).map(notableRow),
  ];
}

type ServiceRun = NonNullable<ViewSnapshot["services"]>[number]["runs"][number];

/** The selection row for a service's workflow run; a fact the run left empty is left out. */
export function runRow(run: ServiceRun, serviceIndex: number): SelectionRow {
  return {
    id: run.id,
    title: [run.workflow, run.result].filter(Boolean).join(" · ") || run.id,
    kind: "run",
    prefixes: [`/services/${serviceIndex}/runs`],
    fields: [
      ...(run.workflow ? [{ label: "Workflow", value: run.workflow }] : []),
      ...(run.result ? [{ label: "Result", value: run.result }] : []),
      ...(run.time && !Number.isNaN(Date.parse(run.time))
        ? [{ label: "When", value: clockTime(run.time), dateTime: run.time }]
        : []),
      ...(run.url ? [{ label: "Link", value: run.url, href: run.url }] : []),
    ],
  };
}

/** Snapshot rows for title/field lookup, including existing callers that select only an id. */
export function selectionRows(snapshot: ViewSnapshot): SelectionRow[] {
  const { briefing, releases } = snapshot;
  const rows: SelectionRow[] = [
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
          { label: "Fork", value: row.fork },
          ...(row.tag ? [{ label: "State", value: row.tag }] : []),
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
        section.lines.flatMap((line, lineIndex) => {
          const row = repositoryLineRow(line, repoIndex, sectionIndex, lineIndex);
          return row ? [row] : [];
        }),
      ),
    ),
    ...briefing.themes.map(
      (theme, index): SelectionRow => ({
        id: `theme:${theme.id}`,
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
            (station.id === "release" || station.id === "lane"
              ? null
              : `station:${service}:${station.id}`),
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
  if (briefing.canWait?.chips.length) rows.push(canWaitRow(briefing.canWait));
  rows.push(
    ...releaseRows(snapshot),
    ...TODAY_GROUPS.map((group) => todayGroupRow(snapshot, group)).filter(
      (row) => row.entries?.length,
    ),
  );
  // An Upstream item the briefing already lists keeps that row; only its own items are added.
  const ids = new Set(rows.map(({ id }) => id));
  return [...rows, ...upstreamItemRows(snapshot).filter(({ id }) => !ids.has(id))];
}

/** An inspect reference elsewhere in the sweep still keeps a Related selection alive. */
export function snapshotHasSelection(snapshot: ViewSnapshot, id: string): boolean {
  const { briefing } = snapshot;
  return (
    selectionRows(snapshot).some((row) => row.id === id || row.inspectId === id) ||
    [...briefing.focus, ...briefing.rest].some((item) => item.ids.includes(id)) ||
    briefing.ready.some((row) => row.id === id) ||
    briefing.flow.also.some((row) => row.inspect === id) ||
    briefing.themes.some((theme) =>
      [...theme.certain, ...theme.possible].some((fork) => fork.inspect === id),
    ) ||
    snapshot.tree.some((node) => node.id === id) ||
    snapshot.selection === id ||
    (snapshot.services?.some((service) =>
      [...service.runs, ...service.releases].some((row) => row.id === id),
    ) ??
      false)
  );
}

/** Membership, not the current DOM, decides whether selection survives a route change. */
export function routeSelectionIds(snapshot: ViewSnapshot, route: Route): string[] {
  const { briefing } = snapshot;
  const queue = [...briefing.focus, ...briefing.rest];
  const repos = briefing.repositories.rows;
  switch (route.kind) {
    case "today":
      return [
        ...queue.map(({ id }) => id),
        ...TODAY_GROUPS.map((group) => todayGroupRow(snapshot, group).id),
        ...briefing.ready.map(({ id }) => id),
        ...(briefing.canWait?.chips.length ? [CAN_WAIT_ID] : []),
        ...releaseRows(snapshot).map(({ id }) => id),
      ];
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
          .map((theme) => `theme:${theme.id}`),
        ...(snapshot.stations.find(({ service }) => service === route.id)?.stations ?? []).map(
          (station) => `station:${route.id}:${station.id}`,
        ),
      ];
    case "engineering-system":
      return [
        ...queue.filter(({ id }) => id === "rollout").map(({ id }) => id),
        ...repos.filter(({ name }) => name === "osdu-spi").map(({ id }) => id),
      ];
    case "environment":
      return [
        briefing.flow.inspect,
        ...briefing.flow.also.flatMap(({ inspect }) => (inspect ? [inspect] : [])),
        ...(
          snapshot.readings.find(({ anchor }) => anchor.kind === "environment")?.content?.items ??
          []
        ).map(({ id }) => id),
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
    case "upstream":
      return upstreamSelectionIds(snapshot);
    case "security":
      return [];
  }
}
