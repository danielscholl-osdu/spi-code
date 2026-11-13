// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type AreaEnvelope, type InspectResult, InspectResultSchema } from "@spi-code/contracts";
import {
  type CoreContext,
  inspectUpstreamFork,
  itemClass,
  type Model,
  type QueueItem,
  stamp,
  UPSTREAM_PREFIX,
} from "@spi-code/core";
import { webUrl } from "./shared.js";

type Line = Model["lines"][number];
type Related = InspectResult["related"][number];

const LINE_STATIONS = {
  upstream: { title: "Upstream", kinds: ["radar", "port"] },
  sync: { title: "Sync PR", kinds: ["halt", "sync-run", "gate1"] },
  cascade: { title: "Cascade", kinds: ["conflict", "cascade", "labels"] },
  main: { title: "Main", kinds: ["main", "gate2"] },
} as const satisfies Record<string, { title: string; kinds: readonly QueueItem["kind"][] }>;

function prRelated(pr: Line["syncPr"], state: string): Related[] {
  return pr ? [{ text: `#${pr.pr.number} ${pr.pr.title}`, state, ...webUrl(pr.pr.url) }] : [];
}

interface Clock {
  readonly now: Date;
  readonly ctx: Pick<CoreContext, "timeStyle">;
}

function runRelated(run: Line["mainRun"], state: string, { now, ctx }: Clock): Related[] {
  return run
    ? [
        {
          text: [
            run.name,
            run.status === "completed" ? run.conclusion : run.status,
            stamp(run.createdAt, now, ctx),
          ]
            .filter(Boolean)
            .join(" · "),
          state,
          ...webUrl(run.url),
        },
      ]
    : [];
}

/** The station's own facts: never another station's cause, so a clean Sync PR stays clean. */
function lineStationFacts(
  line: Line,
  id: keyof typeof LINE_STATIONS,
  clock: Clock,
): { why: string[]; related: Related[] } {
  switch (id) {
    case "upstream":
      return {
        why: (line.upstream?.commits ?? []).slice(0, 3).map((c) => c.title),
        related: line.upstream?.head
          ? [
              {
                text: line.upstream.head.sha.slice(0, 7),
                state: "Upstream head",
                ...webUrl(line.upstream.head.url),
              },
            ]
          : [],
      };
    case "sync":
      return {
        why: [
          ...(line.halt ? [line.halt.detail] : []),
          ...(line.syncPr?.failures.map((f) => f.reason ?? f.check) ?? []),
        ],
        related: [
          ...(line.halt
            ? [
                {
                  text: `#${line.halt.issue.number} ${line.halt.issue.title}`,
                  state: "Halt issue",
                  ...webUrl(line.halt.issue.url),
                },
              ]
            : []),
          ...prRelated(line.syncPr, "Sync PR"),
          ...runRelated(line.syncRun, "Sync Upstream run", clock),
        ],
      };
    case "cascade":
      return {
        why: [
          ...line.conflicts.map((issue) => issue.title),
          ...line.cascadeLabels.filter(
            (label) => label.startsWith("cascade") || label.endsWith("-failed"),
          ),
        ],
        related: [
          ...line.conflicts.map((issue) => ({
            text: `#${issue.number} ${issue.title}`,
            state: "Conflict issue",
            ...webUrl(issue.url),
          })),
          ...(line.tracking
            ? [
                {
                  text: `#${line.tracking.number} ${line.tracking.title}`,
                  state: "Tracking issue",
                  ...webUrl(line.tracking.url),
                },
              ]
            : []),
        ],
      };
    case "main":
      return {
        why: [
          ...(line.cascadePr?.failures.map((f) => f.reason ?? f.check) ?? []),
          ...(line.mainRed && line.mainRed.cls !== "ENV"
            ? [`${line.mainRed.job?.name ?? "Validation"} failed on main`]
            : []),
        ],
        related: [
          ...prRelated(line.cascadePr, "Cascade PR"),
          ...runRelated(line.mainRed?.run ?? line.mainRun, "Main run", clock),
        ],
      };
  }
}

function lineStationResult(
  model: Model,
  line: Line,
  station: Line["stations"][number] & { id: keyof typeof LINE_STATIONS },
  id: string,
  now: Date,
  ctx: CoreContext,
  areas: readonly AreaEnvelope[],
): InspectResult {
  const fork = line.fork.id;
  const { title, kinds } = LINE_STATIONS[station.id];
  const items = model.queue.items.filter(
    (item) => item.scope === fork && (kinds as readonly string[]).includes(item.kind),
  );
  const facts = lineStationFacts(line, station.id, { now, ctx });
  const upstream = inspectUpstreamFork(model, fork, now, { context: ctx });
  return InspectResultSchema.parse({
    id,
    title: `${fork} · ${title}`,
    class:
      station.state === "unknown"
        ? "UNREAD"
        : items[0]
          ? itemClass(items[0])
          : station.state === "stopped"
            ? "INCIDENT"
            : station.state === "waiting"
              ? "GATE"
              : "READY",
    cause: station.text,
    effect: station.state,
    next: "",
    why: facts.why.join("; "),
    related: [
      ...items.map((item) => ({ text: item.text, state: title, inspect: item.id })),
      ...facts.related,
      ...(upstream
        ? [{ text: upstream.title, state: "Upstream", inspect: `${UPSTREAM_PREFIX}${fork}` }]
        : []),
    ],
    evidence: [],
    approval: null,
    actions: [],
    areas,
    provenance: [],
  });
}

export function stationResult(
  model: Model,
  id: string,
  now: Date,
  ctx: CoreContext,
  areas: readonly AreaEnvelope[],
): InspectResult | undefined {
  for (const line of model.lines) {
    const station = line.stations.find((s) => `station:${line.fork.id}:${s.id}` === id);
    if (!station) continue;
    if (station.id in LINE_STATIONS)
      return lineStationResult(
        model,
        line,
        station as Line["stations"][number] & { id: keyof typeof LINE_STATIONS },
        id,
        now,
        ctx,
        areas,
      );
    if (station.id !== "release" && station.id !== "lane") return undefined;
    const release = station.id === "release";
    return InspectResultSchema.parse({
      id,
      title: `${line.fork.id} · ${release ? "Release" : "Stack lane"}`,
      class:
        station.state === "unknown"
          ? "UNREAD"
          : station.state === "stopped"
            ? release
              ? "GATE"
              : "ENV"
            : station.state === "waiting"
              ? "GATE"
              : "READY",
      cause: station.text,
      effect: station.state,
      next: "",
      why: release
        ? (line.releasePr?.failures.map((f) => f.reason ?? f.check).join("; ") ?? "")
        : model.stack.deployable.reason,
      related: release
        ? [
            ...(line.releasePr
              ? [
                  {
                    text: line.releasePr.pr.title,
                    state: "Release PR",
                    ...webUrl(line.releasePr.pr.url),
                  },
                ]
              : []),
            ...(line.release
              ? [
                  {
                    text: line.release.tag,
                    state: stamp(line.release.at, now, ctx) ?? "Release",
                    ...webUrl(line.release.url),
                  },
                ]
              : []),
          ]
        : [
            ...(line.lane.last
              ? [
                  {
                    text: [line.lane.last.ref, line.lane.last.sha].filter(Boolean).join(" · "),
                    state: [line.lane.last.state, stamp(line.lane.last.createdAt, now, ctx)]
                      .filter(Boolean)
                      .join(" · "),
                  },
                ]
              : []),
            ...model.queue.items
              .filter((item) => item.kind === "stack")
              .map((item) => ({ text: item.text, state: "Environment", inspect: item.id })),
          ],
      evidence: [],
      approval: null,
      actions: [],
      areas,
      provenance: [],
    });
  }
  return undefined;
}
