// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { TodayHistory, TodaySummary } from "@spi-code/contracts";
import type { MouseEvent, ReactNode } from "react";
import { type Destination, FORKS, navigate, openEvidence } from "../../app/navigation.js";
import { LinkPill } from "../../components/kit/LinkPill.js";
import { When } from "../../time.js";
import { ageInOneUnit } from "./parts.js";

type Count = TodayHistory["rows"][number]["counts"][number];
type Moving = TodaySummary["moving"][number];

export type LowerPlace = { label: string; destination: Destination };

export const LOWER_PLACES = {
  line: { label: "Forks", destination: FORKS },
  environment: { label: "Environment", destination: { kind: "environment" } },
  engineering: { label: "Template", destination: { kind: "engineering-system" } },
  upstream: { label: "Upstream", destination: { kind: "upstream" } },
  releases: { label: "Releases", destination: { kind: "releases" } },
  security: { label: "Security", destination: { kind: "security" } },
} satisfies Record<string, LowerPlace>;

type PlaceId = keyof typeof LOWER_PLACES;

export type LowerSection = {
  id: "moving" | "history";
  label: ReactNode;
  rows: ReactNode[];
};

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

function joined(parts: readonly ReactNode[]): ReactNode[] {
  return parts.flatMap((part, at) => (at === 0 ? [part] : [" · ", part]));
}

const listed = (names: readonly string[]) =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

function CountText({ count }: { count: Count }) {
  return (
    <span
      className="today-count"
      data-kind={count.kind}
      data-tone={count.tone}
      {...(count.names.length ? { title: count.names.join(", ") } : {})}
    >
      {count.count} {count.kind === "occupied" && count.count === 1 ? "new PR" : count.label}
    </span>
  );
}

/** One row under the four columns: what comes first, the words, a link to its place or its own, and an age. */
function PlaceRow({
  id,
  place,
  first,
  what,
  link,
  age,
}: {
  id: string;
  place: PlaceId;
  first: ReactNode;
  what: ReactNode;
  link?: ReactNode;
  age?: ReactNode;
}) {
  const { label: name, destination } = LOWER_PLACES[place];
  const open = (event: MouseEvent) => {
    event.stopPropagation();
    navigate(destination);
  };
  return (
    <tr className="today-row today-row--place" data-row={id} data-place={place} onClick={open}>
      <td className="today-row-fork">{first}</td>
      <td className="today-row-what">{what}</td>
      <td className="today-row-open">
        {link ?? (
          <button type="button" className="today-row-place" title={`Open ${name}`} onClick={open}>
            {name} ›
          </button>
        )}
      </td>
      <td className="today-row-age">{age}</td>
    </tr>
  );
}

/** The sentence a moving row reads; a case the design does not draw keeps its label and core's count. */
function movingWords(row: Moving): string {
  const { label, count, names } = row;
  if (row.what) return `${row.fork ?? label}: ${row.what}`;
  switch (row.id) {
    case "sync":
      if (names.length) return `${label} for ${listed(names)}`;
      return `${label} · ${count ? `opens ${plural(count, "sync PR")}` : "no sync PRs to open"}`;
    case "template":
      return count
        ? `${label} for the ${plural(count, "fork")} not yet started`
        : `${label} · no PRs to open`;
    case "lanes":
      return `${label} · ${plural(count, "lane")} busy${names.length ? `: ${names.join(", ")}` : ""}`;
    case "environment":
      return `${label} running`;
    default:
      return `${label} · ${count}`;
  }
}

function movingRow(row: Moving) {
  const gaps = row.notRead ?? [];
  return (
    <PlaceRow
      key={row.id}
      id={row.id}
      place={row.place}
      first={<span className="today-row-when">{row.at ? <When at={row.at} /> : row.time}</span>}
      what={
        <span
          className="today-row-moving"
          data-count={row.count}
          {...(row.names.length ? { title: row.names.join(", ") } : {})}
        >
          {movingWords(row)}
        </span>
      }
      {...(row.link ? { link: <LinkPill link={row.link} /> } : {})}
      age={
        <>
          {gaps.length > 0 && (
            <button
              type="button"
              className="today-row-gaps"
              aria-label={`${gaps.length} not read: open Evidence`}
              title={`${gaps.join(", ")} not read · opens Evidence`}
              onClick={(event) => {
                event.stopPropagation();
                openEvidence(null);
              }}
            >
              ⌀ {gaps.length} ›
            </button>
          )}
          {row.age && <span className="today-row-age-text">{ageInOneUnit(row.age)}</span>}
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
      place={row.place}
      first={<span className="today-row-label">{row.label}</span>}
      what={joined([
        plural(forks, "fork"),
        ...row.counts.map((count) => <CountText key={count.kind} count={count} />),
      ])}
    />
  );
}

/**
 * The window the history covers: Since you last looked with its time, or Last 24 hours, followed in
 * muted words by how far core's history reaches when it is short or stale.
 */
function historyLabel(history: TodayHistory): ReactNode {
  const muted = (words: string, at: string) => (
    <span className="today-section-coverage">
      {words}
      <When at={at} />
    </span>
  );
  if (history.basis === "seen") return <>Since you last looked {muted("", history.from)}</>;
  if (history.basis === "history-short") return <>Last 24 hours {muted("since ", history.from)}</>;
  if (history.asOf) return <>Last 24 hours {muted("to ", history.asOf)}</>;
  return "Last 24 hours";
}

/** Moving without you and the history from core's Today summary; a section with no rows is left out. */
export function lowerSections(summary: TodaySummary | undefined): LowerSection[] {
  if (!summary) return [];
  const sections: LowerSection[] = [
    { id: "moving", label: "Moving without you", rows: summary.moving.map(movingRow) },
    {
      id: "history",
      label: historyLabel(summary.history),
      rows: summary.history.rows.map(historyRow),
    },
  ];
  return sections.filter(({ rows }) => rows.length > 0);
}
