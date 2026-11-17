// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { TodayHistory, TodaySummary } from "@spi-code/contracts";
import type { MouseEvent, ReactNode } from "react";
import { type Destination, LINE, navigate, openEvidence } from "../../app/navigation.js";
import { Time } from "../../time.js";

type Count = TodaySummary["canWait"][number]["counts"][number];
type Moving = TodaySummary["moving"][number];

export type LowerPlace = { label: string; destination: Destination };

export const LOWER_PLACES = {
  line: { label: "Line", destination: LINE },
  environment: { label: "Environment", destination: { kind: "environment" } },
  engineering: { label: "Engineering system", destination: { kind: "engineering-system" } },
  upstream: { label: "Upstream", destination: { kind: "upstream" } },
  releases: { label: "Releases", destination: { kind: "releases" } },
  security: { label: "Security", destination: { kind: "security" } },
} satisfies Record<string, LowerPlace>;

type PlaceId = keyof typeof LOWER_PLACES;

export type LowerSection = {
  id: "can-wait" | "moving" | "history";
  label: ReactNode;
  rows: ReactNode[];
};

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

function joined(parts: readonly ReactNode[]): ReactNode[] {
  return parts.flatMap((part, at) => (at === 0 ? [part] : [" · ", part]));
}

function CountText({ count }: { count: Count }) {
  return (
    <span
      className="today-count"
      data-kind={count.kind}
      data-tone={count.tone}
      {...(count.names.length ? { title: count.names.join(", ") } : {})}
    >
      {count.count} {count.label}
    </span>
  );
}

function PlaceRow({
  id,
  label,
  place,
  what,
  age,
}: {
  id: string;
  label: string;
  place: PlaceId;
  what: ReactNode;
  age?: ReactNode;
}) {
  const { label: name, destination } = LOWER_PLACES[place];
  const open = (event: MouseEvent) => {
    event.stopPropagation();
    navigate(destination);
  };
  return (
    <tr className="today-row today-row--place" data-row={id} data-place={place} onClick={open}>
      <td className="today-row-fork">
        <button type="button" title={`Open ${name}`} onClick={open}>
          {label}
        </button>
      </td>
      <td className="today-row-what" colSpan={2}>
        {what}
      </td>
      <td className="today-row-age">
        {age}
        <span className="today-row-go" aria-hidden="true">
          ›
        </span>
      </td>
    </tr>
  );
}

/** A pile core could not read says so, and a zero it could not prove is never drawn. */
function pileRow(pile: TodaySummary["canWait"][number]) {
  const gaps = pile.notRead.length;
  const shown = pile.counts.filter(({ count }) => count > 0);
  const what = shown.length ? (
    joined(shown.map((count) => <CountText key={count.kind} count={count} />))
  ) : (
    <span className="today-count" data-tone="muted">
      {gaps ? "not read" : "none"}
    </span>
  );
  const age = gaps ? (
    <button
      type="button"
      className="today-row-gaps"
      aria-label={`${gaps} not read: open Evidence`}
      title={pile.notRead.join(", ")}
      onClick={(event) => {
        event.stopPropagation();
        openEvidence(null);
      }}
    >
      ⌀ {gaps}
    </button>
  ) : undefined;
  return (
    <PlaceRow
      key={pile.id}
      id={pile.id}
      label={pile.label}
      place={pile.place}
      what={what}
      {...(age ? { age } : {})}
    />
  );
}

function movingWords(row: Moving): string {
  switch (row.id) {
    case "lanes":
      return `${plural(row.count, "lane")} busy${row.names.length ? `: ${row.names.join(", ")}` : ""}`;
    case "template":
      return row.count ? `opens PRs on ${plural(row.count, "fork")}` : "no PRs to open";
    case "sync":
      return row.count ? `opens ${plural(row.count, "sync PR")}` : "no sync PRs to open";
    case "environment":
      return "running";
    default:
      return String(row.count);
  }
}

function movingRow(row: Moving) {
  const when = row.at ? <Time at={row.at} hint={false} /> : row.time;
  const words = movingWords(row);
  return (
    <PlaceRow
      key={row.id}
      id={row.id}
      label={row.label}
      place={row.place}
      what={
        <>
          <span className="today-row-when">{when}</span> ·{" "}
          <span
            className="today-row-moving"
            data-count={row.count}
            {...(row.names.length ? { title: row.names.join(", ") } : {})}
          >
            {words}
          </span>
        </>
      }
    />
  );
}

function historyRow(row: TodayHistory["rows"][number]) {
  const forks = row.counts.reduce((n, { count }) => n + count, 0);
  return (
    <PlaceRow
      key={row.workflow}
      id={row.workflow}
      label={row.label}
      place={row.place}
      what={joined([
        plural(forks, "fork"),
        ...row.counts.map((count) => <CountText key={count.kind} count={count} />),
      ])}
    />
  );
}

/** The window the history covers, named only as far as core vouches for it. */
function historyLabel(history: TodayHistory): ReactNode {
  if (history.basis === "seen")
    return (
      <>
        Since you last looked, <Time at={history.from} hint={false} />
      </>
    );
  if (history.basis === "history-short")
    return (
      <>
        Since <Time at={history.from} hint={false} />
      </>
    );
  if (history.asOf)
    return (
      <>
        24 hours to <Time at={history.asOf} hint={false} />
      </>
    );
  return "Last 24 hours";
}

/** Can wait, Moving without you and Last 24 hours, from core's Today summary; each row opens its place. */
export function lowerSections(summary: TodaySummary | undefined): LowerSection[] {
  if (!summary) return [];
  return [
    { id: "can-wait", label: "Can wait", rows: summary.canWait.map(pileRow) },
    { id: "moving", label: "Moving without you", rows: summary.moving.map(movingRow) },
    {
      id: "history",
      label: historyLabel(summary.history),
      rows: summary.history.rows.map(historyRow),
    },
  ];
}
