// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { AmbientLine, CanWait, LineStation, ViewSnapshot } from "@spi-code/contracts";
import { useStore } from "zustand";
import { navigate } from "../../app/navigation.js";
import { AgeChip, Chip, PrBadge, ServiceChip, UpstreamChip } from "../../components/kit/Chip.js";
import {
  type LineStation as GlyphStation,
  LineGlyph,
  LineGlyphLegend,
} from "../../components/kit/LineGlyph.js";
import type { SlotState } from "../../components/kit/Slot.js";
import { type SelectionStore, selectionStore } from "../../panels/selection.js";
import {
  CAN_WAIT_ID,
  canWaitRow,
  type SelectionRow,
  selectionRows,
} from "../../panels/selection-rows.js";
import "./in-motion.css";

const GLYPH_STATION: Readonly<Record<LineStation, GlyphStation>> = {
  sync: "sync-pr",
  cascade: "release-upstream-pr",
  main: "main",
  release: "release",
};

const SLOT_STATE = { warn: "waiting", bad: "broken", ok: "occupied", neutral: "occupied" } as const;

function slotState(line: AmbientLine): SlotState {
  return line.state ? SLOT_STATE[line.state.tone] : "occupied";
}

const openService = (service: string) => navigate({ kind: "service", id: service });

function itemRow(rows: readonly SelectionRow[], id: string, title: string): SelectionRow {
  return rows.find((row) => row.kind === "queue" && row.id === id) ?? { id, title, kind: "queue" };
}

function Open({
  label,
  selected,
  onOpen,
}: {
  label: string;
  selected: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="today-motion-open"
      aria-label={label}
      aria-pressed={selected}
      title={label}
      onClick={onOpen}
    >
      <span aria-hidden="true">›</span>
    </button>
  );
}

function Line({
  line,
  rows,
  selected,
  select,
}: {
  line: AmbientLine;
  rows: readonly SelectionRow[];
  selected: string | null;
  select: (row: SelectionRow) => void;
}) {
  const [first = line.id] = line.itemIds;
  const row = itemRow(rows, first, line.text);
  const shared = {
    "data-line-id": line.id,
    "data-item-ids": line.itemIds.join(" "),
    "data-count": line.count,
    "data-origin": line.origin,
    "data-selected": selected === row.id || undefined,
    title: line.text,
  };
  const count = line.count > 1 && (
    <span className="today-motion-count" aria-hidden="true">
      {line.count}
    </span>
  );
  const open = <Open label={line.text} selected={selected === row.id} onOpen={() => select(row)} />;
  if (line.next !== undefined)
    return (
      <li className="today-motion-line today-motion-rollout" {...shared}>
        <span className="today-motion-label">Template</span>
        <span className="today-motion-next">
          {line.next.length > 0 ? (
            line.next.map((service) => (
              <ServiceChip
                key={service}
                service={service}
                text={service}
                onOpen={() => openService(service)}
              />
            ))
          ) : (
            <span className="today-motion-quiet">{line.text}</span>
          )}
          {count}
        </span>
        <span className="today-motion-age">
          {line.age && <AgeChip age={line.age} text={line.text} />}
        </span>
        {open}
      </li>
    );
  const prRow = line.pr && itemRow(rows, line.pr.inspect ?? first, line.text);
  const plain = !line.station && !line.pr && !line.state;
  return (
    <li
      className={plain ? "today-motion-line today-motion-plain" : "today-motion-line"}
      {...shared}
      {...(line.station ? { "data-station": line.station } : {})}
      {...(line.pr?.url ? { "data-pr-url": line.pr.url } : {})}
      {...(line.pr?.inspect ? { "data-pr-inspect": line.pr.inspect } : {})}
    >
      <span className="today-motion-service">
        {line.service && (
          <ServiceChip
            service={line.service}
            text={line.service}
            onOpen={() => openService(line.service ?? "")}
          />
        )}
      </span>
      {plain ? (
        <span className="today-motion-text">{line.text}</span>
      ) : (
        <>
          <span className="today-motion-glyph">
            {line.station && (
              <LineGlyph
                station={GLYPH_STATION[line.station]}
                state={slotState(line)}
                origin={line.origin}
                text={line.text}
              />
            )}
          </span>
          <span className="today-motion-pr">
            {line.pr && prRow && (
              <PrBadge
                number={line.pr.number}
                text={`PR #${line.pr.number}`}
                onOpen={() => select(prRow)}
              />
            )}
          </span>
        </>
      )}
      <span className="today-motion-state">
        {line.state && <Chip label={line.state.text} text={line.text} tone={line.state.tone} />}
        {line.followUp && <Chip label={line.followUp} text={line.followUp} tone="plain" />}
        {line.origin === "upstream" && <UpstreamChip text={line.text} />}
        {count}
      </span>
      <span className="today-motion-age">
        {line.age && <AgeChip age={line.age} text={line.text} />}
      </span>
      {open}
    </li>
  );
}

function CanWaitChips({
  canWait,
  selected,
  select,
}: {
  canWait: CanWait;
  selected: boolean;
  select: (row: SelectionRow) => void;
}) {
  const row = canWaitRow(canWait);
  const ids = canWait.items.flatMap(({ id, itemIds }) => [id, ...itemIds]);
  return (
    <div className="today-canwait" data-selected={selected || undefined} data-ids={ids.join(" ")}>
      <h3 className="today-motion-head">Can wait</h3>
      {canWait.chips.map((chip, index) => (
        <button
          // biome-ignore lint/suspicious/noArrayIndexKey: core may name two chips alike
          key={index}
          type="button"
          className="kit-chip kit-chip--plain today-canwait-chip"
          aria-label={`${chip.text}: open the Can wait list`}
          aria-pressed={selected}
          title="Open the Can wait list in Detail, with why each item can wait"
          {...(chip.service ? { "data-service": chip.service } : {})}
          {...(chip.count !== undefined ? { "data-count": chip.count } : {})}
          onClick={() => select(row)}
        >
          {chip.text}
        </button>
      ))}
    </div>
  );
}

/** Today's motion slot: In motion when core sends an In progress line or a Can wait chip, else empty. */
export function motionSlot(snapshot: ViewSnapshot) {
  const { ambient, canWait } = snapshot.briefing;
  return (ambient?.inProgress.lines.length ?? 0) > 0 || (canWait?.chips.length ?? 0) > 0 ? (
    <InMotion snapshot={snapshot} />
  ) : null;
}

/** In motion: core's In progress run as item rows, then Can wait's chips. Empty, it draws nothing. */
export function InMotion({
  snapshot,
  selection = selectionStore,
}: {
  snapshot: ViewSnapshot;
  selection?: SelectionStore;
}) {
  const selected = useStore(selection, (state) => state.selected);
  const { ambient, canWait } = snapshot.briefing;
  const run = ambient?.inProgress;
  const lines = run?.lines ?? [];
  const chips = canWait && canWait.chips.length > 0 ? canWait : undefined;
  if (lines.length === 0 && !chips) return null;
  const rows = selectionRows(snapshot);
  const select = (row: SelectionRow) => selection.getState().select(row.id, row);
  const legend =
    lines.some(({ station }) => station) && !ambient?.failing.lines.some(({ station }) => station);
  return (
    <section className="today-motion" aria-label="In motion">
      {run && lines.length > 0 && (
        <div className="today-motion-run" data-items={run.items}>
          <h3 className="today-motion-head">
            In motion <span className="today-motion-figure">· {run.text}</span>
          </h3>
          <ul className="today-motion-lines">
            {lines.map((line) => (
              <Line key={line.id} line={line} rows={rows} selected={selected} select={select} />
            ))}
          </ul>
          {legend && <LineGlyphLegend />}
        </div>
      )}
      {chips && (
        <CanWaitChips canWait={chips} selected={selected === CAN_WAIT_ID} select={select} />
      )}
    </section>
  );
}
