// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { AreaName, Envelope, Since as SinceField, ViewSnapshot } from "@spi-code/contracts";
import { AREA_NAMES } from "../../components/evidence/words.js";
import { SlotLegend, SlotRow } from "../../components/kit/SlotRow.js";
import { areaEnvelope } from "../../store/evidence.js";
import { clockTime, Time } from "../../time.js";

const SINCE = "/briefing/since";

/** The areas core says the since rows read, each with its envelope; absent reads as not read. */
function sinceAreas(snapshot: Pick<ViewSnapshot, "areas" | "provenance">) {
  const areas = new Set<AreaName>();
  for (const { path, areas: named } of snapshot.provenance)
    if (path === SINCE || path.startsWith(`${SINCE}/`)) for (const area of named) areas.add(area);
  return [...areas].map((area) => ({ area, envelope: areaEnvelope(snapshot, area) }));
}

const lastGood = (envelope: Envelope) =>
  envelope.state === "unread" ? undefined : envelope.observedAt;

const HELD: Readonly<Record<Envelope["state"], string>> = {
  fresh: "read",
  stale: "stale",
  incomplete: "read only in part",
  failed: "read failed",
  unread: "not read yet",
};

function heldWords(envelope: Envelope): string {
  const kept = lastGood(envelope);
  return kept
    ? `${HELD[envelope.state]}, last good read ${clockTime(kept, { hint: false })}`
    : HELD[envelope.state];
}

/** ⌀ when an area the since rows read was not read whole this sweep, with its oldest last good time. */
function Held({
  snapshot,
  onOpenEvidence,
}: {
  snapshot: Pick<ViewSnapshot, "areas" | "provenance">;
  onOpenEvidence: () => void;
}) {
  const held = sinceAreas(snapshot).filter(({ envelope }) => envelope.state !== "fresh");
  if (held.length === 0) return null;
  const times = held.map(({ envelope }) => lastGood(envelope));
  const oldest = times.every((time) => time !== undefined)
    ? times.sort((a, b) => Date.parse(a) - Date.parse(b))[0]
    : undefined;
  const title = held
    .map(({ area, envelope }) => `${AREA_NAMES[area]} · ${heldWords(envelope)}`)
    .join("\n");
  return (
    <button
      type="button"
      className="kit-chip kit-chip--warn today-held"
      aria-label={`Not every source these rows read is current. ${title.replaceAll("\n", "; ")}. Open Evidence.`}
      title={title}
      onClick={onOpenEvidence}
    >
      <span aria-hidden="true">⌀</span>{" "}
      {oldest ? (
        <>
          from <Time at={oldest} hint={false} />
        </>
      ) : (
        "not read"
      )}
    </button>
  );
}

function Basis({ since }: { since: SinceField }) {
  const from = clockTime(since.from, { hint: false });
  const [label, title] =
    since.basis === "fallback"
      ? ["24 h", `No last-look baseline yet, so the last 24 hours, from ${from}.`]
      : since.basis === "seen"
        ? [`since ${from}`, `Since you last looked, at ${from}.`]
        : since.basis === "history-short"
          ? [`since ${from}`, `Since ${from}, the oldest run read.`]
          : [
              `as of ${since.asOf ? clockTime(since.asOf, { hint: false }) : from}`,
              `Runs weren't read this sweep; these are the runs from ${from}.`,
            ];
  return (
    <span className="kit-chip kit-chip--plain today-since-basis" title={title}>
      <time dateTime={since.basis === "stale" && since.asOf ? since.asOf : since.from}>
        {label}
      </time>
    </span>
  );
}

/** What the runs since the last look did, one pip row per workflow, with one legend of what's drawn. */
export function Since({
  snapshot,
  onOpenEvidence,
}: {
  snapshot: Pick<ViewSnapshot, "areas" | "provenance"> & {
    briefing: { since?: SinceField | undefined };
  };
  onOpenEvidence: () => void;
}) {
  const since = snapshot.briefing.since;
  if (!since) return null;
  return (
    <section className="today-since" aria-label="Since the last look" data-basis={since.basis}>
      <Basis since={since} />
      {since.rows.map((row) => (
        <div className="today-since-row" key={row.workflow} data-workflow={row.workflow}>
          <SlotRow
            label={row.label}
            count={row.countText}
            text={`${row.label}: ${row.countText}`}
            entries={row.slots.map((slot) => ({
              id: slot.service,
              state: slot.state,
              text: slot.text,
              ...(slot.origin ? { origin: slot.origin } : {}),
            }))}
            showLegend={false}
          />
        </div>
      ))}
      <Held snapshot={snapshot} onOpenEvidence={onOpenEvidence} />
      <SlotLegend states={since.rows.flatMap(({ slots }) => slots.map(({ state }) => state))} />
    </section>
  );
}
