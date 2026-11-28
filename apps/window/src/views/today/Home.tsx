// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type TodayMemberStation, todayMembers, type ViewSnapshot } from "@spi-code/contracts";
import { useId } from "react";
import { FORKS, navigate, openEvidence, type TodayTab } from "../../app/navigation.js";
import { ariaShortcut } from "../../app/shortcuts.js";
import { openCause } from "./CanWait.js";
import { FleetFlow } from "./FleetFlow.js";
import { Forks } from "./Forks.js";
import { FILTER_NAMES, filterFigure, fleetCells } from "./fleet.js";
import { lowerSections } from "./Lower.js";
import { Section } from "./parts.js";
import { TodayTable } from "./Table.js";

const TABS = [
  { id: "yours", label: "Yours" },
  { id: "forks", label: "Forks" },
  { id: "activity", label: "Activity" },
] as const satisfies readonly { id: "yours" | TodayTab; label: string }[];

function Activity({ snapshot }: { snapshot: ViewSnapshot }) {
  return (
    <div className="today-table">
      {lowerSections(snapshot.briefing.today).map(({ id, label, rows }) => (
        <Section key={id} id={id} label={label}>
          <tbody>{rows}</tbody>
        </Section>
      ))}
    </div>
  );
}

/** Today across the forks: the fleet flow, then Yours, Forks or Activity. */
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
  const yours = todayMembers(briefing).length;
  const { notRead, cascade } = station
    ? filterFigure(fleet, station)
    : { notRead: [], cascade: [] };
  return (
    <>
      {flow && <FleetFlow cells={flow} />}
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
                ...(station && id !== "activity" ? { station } : {}),
              })
            }
          >
            {label}
            {id === "forks" && stopped.length > 0 && (
              <span className="today-tab-count" title={stopped.join(", ")}>
                {stopped.length} stopped
              </span>
            )}
            {id === "yours" && yours > 0 && (
              <span className="today-tab-count" title={`${yours} rows that are yours`}>
                {yours}
              </span>
            )}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-${active}`}>
        {active === "activity" ? (
          <Activity snapshot={snapshot} />
        ) : (
          <>
            {station && (
              <div className="today-filter" data-station={station}>
                <span>Showing {FILTER_NAMES[station]}</span>
                <button type="button" onClick={() => navigate(filterRoute)}>
                  Show all ✕
                </button>
              </div>
            )}
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
                  {...(station
                    ? { calm: notRead.length ? null : "Nothing waiting on you here." }
                    : {})}
                />
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
