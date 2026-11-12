// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type {
  AreaName,
  Mark as PlaceMark,
  PlaceRow,
  PlaceVisual,
  ViewSnapshot,
} from "@spi-code/contracts";
import { type Destination, type Navigation, navigate } from "../../app/navigation.js";
import { AREA_NAMES, stateWord } from "../../components/evidence/words.js";
import { Chip, UpstreamChip } from "../../components/kit/Chip.js";
import { Mark, type MarkTier } from "../../components/kit/Mark.js";
import { Slot } from "../../components/kit/Slot.js";
import { selectionStore } from "../../panels/selection.js";
import { areaEnvelope } from "../../store/evidence.js";
import { plainTitle } from "../../text.js";
import { clockTime, Time } from "../../time.js";
import "./places.css";

const PLACES = {
  line: { label: "Line", route: { kind: "line" } },
  environment: { label: "Environment", route: { kind: "environment" } },
  engineering: { label: "Engineering system", route: { kind: "engineering-system" } },
  security: { label: "Security", route: { kind: "security" } },
} as const satisfies Record<PlaceRow["place"], { label: string; route: Destination }>;
const TIER: Record<PlaceMark, MarkTier> = {
  stopped: "interrupt",
  "needs-person": "surface",
  "in-progress": "ambient",
  "nothing-due": "background",
};

function openArea(area: AreaName) {
  selectionStore.getState().openSweepEvidence();
  const reveal = (remaining: number) => {
    const row = document.querySelector<HTMLElement>(
      `[data-evidence="sweep"] [data-source="${area}"]`,
    );
    if (row) {
      row.tabIndex = -1;
      row.scrollIntoView?.({ block: "center" });
      row.focus({ preventScroll: true });
    } else if (remaining > 0) requestAnimationFrame(() => reveal(remaining - 1));
  };
  requestAnimationFrame(() => reveal(10));
}

function Held({ row, snapshot }: { row: PlaceRow; snapshot: ViewSnapshot }) {
  const unread = row.unread;
  if (!unread) return null;
  const reads = unread.areas.map((area) => ({ area, envelope: areaEnvelope(snapshot, area) }));
  const title = reads
    .map(
      ({ area, envelope }) =>
        `${AREA_NAMES[area]}: ${stateWord(envelope)}${envelope.state !== "unread" && envelope.observedAt ? `, last good ${clockTime(envelope.observedAt, { hint: false })}` : ""}`,
    )
    .join("; ");
  const area =
    reads.find(
      ({ envelope }) =>
        unread.lastGood !== undefined &&
        envelope.state !== "unread" &&
        envelope.observedAt === unread.lastGood,
    )?.area ?? unread.areas[0];
  return (
    <button
      type="button"
      className="kit-chip kit-chip--plain today-place-held"
      data-areas={unread.areas.join(" ")}
      title={title}
      aria-label={`${title}. Open Evidence.`}
      onClick={() => area && openArea(area)}
    >
      <span aria-hidden="true">⌀</span>
      {unread.lastGood ? (
        <>
          from <Time at={unread.lastGood} hint={false} />
        </>
      ) : (
        "not read"
      )}
    </button>
  );
}

function Visual({
  visual,
  line,
  onNavigate,
}: {
  visual: PlaceVisual;
  line: string;
  onNavigate: Navigation["navigate"];
}) {
  const service = (id: string) => onNavigate({ kind: "service", id });
  if (visual.kind === "pips" || visual.kind === "rollout")
    return (
      <div
        data-visual={visual.kind}
        data-target={visual.kind === "rollout" ? visual.target : undefined}
      >
        <div className="today-place-columns" title={line}>
          {visual.slots.map(({ service: id, state, text: raw, origin }) => {
            const text = plainTitle(raw);
            return (
              <button
                type="button"
                className="today-place-slot"
                data-service={id}
                data-state={state}
                data-origin={origin}
                key={id}
                title={text}
                aria-label={text}
                onClick={() => service(id)}
              >
                {visual.kind === "pips" || state !== "done" ? (
                  <Slot state={state} text={text} {...(origin ? { origin } : {})} />
                ) : (
                  <span className="kit-cell kit-cell--filled" aria-hidden="true" />
                )}
              </button>
            );
          })}
        </div>
        {visual.kind === "pips" && (
          <>
            <div className="today-place-stopped">
              {visual.stopped.map((id) => (
                <button
                  type="button"
                  className="kit-chip kit-chip--bad"
                  data-service={id}
                  key={id}
                  onClick={() => service(id)}
                >
                  {id}
                </button>
              ))}
            </div>
            {visual.horizon && (
              <UpstreamChip
                label={plainTitle(visual.horizon.text).replace(/^⇣\s*/, "")}
                text={plainTitle(visual.horizon.text)}
                onOpen={() =>
                  document
                    .querySelector<HTMLElement>('[data-today-slot="horizon"]')
                    ?.scrollIntoView?.({ block: "start" })
                }
              />
            )}
          </>
        )}
      </div>
    );
  if (visual.kind === "lifecycle")
    return (
      <div data-visual={visual.kind}>
        <div className="today-place-lifecycle">
          {visual.lanes.map((lane) => (
            <div
              key={lane.lane}
              data-lane={lane.lane}
              data-total={lane.total}
              data-state={lane.state}
              title={plainTitle(lane.text)}
            >
              <span>{lane.lane}</span>
              <meter
                className="kit-bar"
                min={0}
                max={lane.total || 1}
                value={lane.green}
                title={plainTitle(lane.text)}
                aria-label={plainTitle(lane.text)}
              />
              <span>{lane.state === "unknown" ? "?" : `${lane.green}/${lane.total}`}</span>
            </div>
          ))}
        </div>
        {visual.greenSince && (
          <span className="kit-chip kit-chip--plain today-place-green">
            green since <Time at={visual.greenSince} hint={false} />
          </span>
        )}
      </div>
    );
  const scale = Math.max(1, ...visual.columns.map(({ count }) => count ?? 0));
  return (
    <div data-visual={visual.kind}>
      <div className="today-place-columns today-place-security" title={line}>
        {visual.columns.map((column) => (
          <button
            type="button"
            className="today-place-column"
            data-service={column.service}
            data-count={String(column.count)}
            key={column.service}
            title={plainTitle(column.text)}
            aria-label={plainTitle(column.text)}
            onClick={() => service(column.service)}
          >
            {column.count === null ? (
              <span className="today-place-unknown">?</span>
            ) : (
              <span
                className="kit-segment kit-segment--warn"
                style={{ height: `${2 + (column.count / scale) * 36}px` }}
                aria-hidden="true"
              />
            )}
          </button>
        ))}
      </div>
      {visual.program && (
        <div className="today-place-program" data-count={String(visual.program.count)}>
          <Chip label={visual.program.text} text={plainTitle(visual.program.text)} />
        </div>
      )}
      {visual.largest && (
        <div className="today-place-largest">
          <Chip label={visual.largest.text} text={plainTitle(visual.largest.text)} />
        </div>
      )}
    </div>
  );
}

export function Places({
  snapshot,
  onNavigate = navigate,
}: {
  snapshot: ViewSnapshot;
  onNavigate?: Navigation["navigate"] | undefined;
}) {
  const rows = snapshot.briefing.places;
  if (!rows?.length) return null;
  return (
    <section className="today-places" aria-label="System health">
      {rows.map((row) => {
        const { label, route } = PLACES[row.place];
        const line = plainTitle(row.line);
        return (
          <article
            className="today-place card"
            key={row.place}
            data-place={row.place}
            data-mark={row.mark}
            data-areas={row.areas.join(" ")}
            data-items={row.itemIds.join(" ")}
            data-unread={row.unread ? "" : undefined}
          >
            <h3>
              <button
                type="button"
                className="today-place-open"
                title={line}
                onClick={() => onNavigate(route)}
              >
                <Mark tier={TIER[row.mark]} />
                {label}
              </button>
            </h3>
            <div className="today-place-figure" data-tone={row.tone} title={line}>
              {row.figure}
            </div>
            <div className="today-place-chips">
              {row.mark !== "nothing-due" && row.reason && (
                <span className="today-place-reason">
                  <Chip label={row.reason} text={line} tone={row.tone === "bad" ? "bad" : "warn"} />
                </span>
              )}
              {(row.fresh?.itemIds.length ?? 0) > 0 && (
                <button
                  type="button"
                  className="kit-chip kit-chip--accent today-place-new"
                  data-items={row.fresh?.itemIds.join(" ")}
                  aria-label={`Open ${label}, new items marked`}
                  onClick={() => onNavigate(route)}
                >
                  new
                </button>
              )}
              <Held row={row} snapshot={snapshot} />
            </div>
            {row.caveat && <p className="today-place-caveat">{row.caveat}</p>}
            {row.visual && <Visual visual={row.visual} line={line} onNavigate={onNavigate} />}
          </article>
        );
      })}
    </section>
  );
}
