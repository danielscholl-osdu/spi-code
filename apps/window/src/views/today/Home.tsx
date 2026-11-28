// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  fleetLines,
  type TodayCounts,
  type TodayMemberStation,
  todayCounts,
  type ViewSnapshot,
} from "@spi-code/contracts";
import { useId } from "react";
import { FORKS, navigate, openEvidence, type TodayTab } from "../../app/navigation.js";
import { ariaShortcut } from "../../app/shortcuts.js";
import { openCause } from "./CanWait.js";
import { FleetFlow } from "./FleetFlow.js";
import { Forks } from "./Forks.js";
import { FILTER_NAMES, filterFigure, fleetCells } from "./fleet.js";
import { TodayTable } from "./Table.js";

const TABS = [
  { id: "yours", label: "Yours" },
  { id: "forks", label: "Forks" },
] as const satisfies readonly { id: "yours" | TodayTab; label: string }[];

/** The split a count reads as words: "3 blocked", "15 waiting", a count of none left out. */
export function splitWords(counts: TodayCounts): { tone: "bad" | "warn"; text: string }[] {
  return [
    ...(counts.blocked ? [{ tone: "bad" as const, text: `${counts.blocked} blocked` }] : []),
    ...(counts.waiting ? [{ tone: "warn" as const, text: `${counts.waiting} waiting` }] : []),
  ];
}

/** Today across the forks: the fleet flow, then Yours or Forks. */
export function TodayHome({
  snapshot,
  tab,
  station,
}: {
  snapshot: ViewSnapshot;
  tab: TodayTab | undefined;
  station: TodayMemberStation | undefined;
}) {
  const ids = useId();
  const { briefing } = snapshot;
  const fleet = briefing.today?.fleet;
  const active = tab ?? "yours";
  const filterRoute =
    active === "forks" ? ({ kind: "today", tab: "forks" } as const) : ({ kind: "today" } as const);
  const flow =
    fleet &&
    fleetCells(fleet, briefing.lines ?? [], station, {
      filter: (next) =>
        navigate(next === station ? filterRoute : { ...filterRoute, station: next }),
      cause: openCause,
      upstream: () => navigate({ kind: "upstream" }),
      forks: () => navigate(FORKS),
      environment: () => navigate({ kind: "environment" }),
      evidence: () => openEvidence(null),
    });
  const stopped = fleet?.forks.stopped ?? [];
  const yours = splitWords(todayCounts(briefing));
  const scope =
    station &&
    [
      FILTER_NAMES[station],
      ...splitWords(todayCounts({ lines: fleetLines(briefing.lines ?? [], station) })).map(
        ({ text }) => text,
      ),
    ].join(" · ");
  const { notRead, cascade } = station
    ? filterFigure(fleet, station)
    : { notRead: [], cascade: [] };
  return (
    <>
      {flow && <FleetFlow cells={flow} />}
      <div className="today-tabrow">
        <div className="today-tabs" role="tablist" aria-label="Today tabs">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`${ids}-${id}`}
              className="today-tab"
              data-today-tab={id}
              aria-selected={id === active}
              aria-controls={`${ids}-panel`}
              aria-keyshortcuts={id === "forks" ? ariaShortcut("l") : undefined}
              onClick={() =>
                navigate({
                  kind: "today",
                  ...(id !== "yours" ? { tab: id } : {}),
                  ...(station ? { station } : {}),
                })
              }
            >
              {label}
              {id === "forks" && stopped.length > 0 && (
                <span className="today-tab-count" data-tone="bad" title={stopped.join(", ")}>
                  {stopped.length} stopped
                </span>
              )}
              {id === "yours" &&
                yours.map(({ tone, text }) => (
                  <span key={tone} className="today-tab-count" data-tone={tone}>
                    {text}
                  </span>
                ))}
            </button>
          ))}
        </div>
        {station && (
          <div className="today-filter" data-station={station}>
            <span className="today-filter-scope">{scope}</span>
            <button type="button" onClick={() => navigate(filterRoute)}>
              Show all
            </button>
          </div>
        )}
      </div>
      <div role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-${active}`}>
        {active === "forks" ? (
          <Forks snapshot={snapshot} fleet={fleet} station={station} />
        ) : (
          <>
            {cascade.length > 0 && (
              <p className="today-filter-note">Waiting for cascade on {cascade.join(", ")}.</p>
            )}
            <TodayTable
              snapshot={snapshot}
              station={station}
              {...(station ? { calm: notRead.length ? null : "Nothing waiting on you here." } : {})}
            />
          </>
        )}
      </div>
    </>
  );
}
