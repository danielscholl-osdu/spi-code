// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { SLOT_STATES, Slot, type SlotProps, type SlotState } from "./Slot.js";

export interface SlotEntry extends SlotProps {
  id: string;
}

export interface SlotRowProps {
  label: string;
  count: string;
  text: string;
  entries: readonly SlotEntry[];
  showLegend?: boolean;
}

const LEGEND: Record<SlotState, string> = {
  empty: "empty",
  occupied: "occupied",
  done: "done",
  waiting: "waiting",
  broken: "broken",
  unknown: "ran, effect unknown",
};

/** One legend for the slot states actually drawn, in the kit's fixed order. */
export function SlotLegend({ states }: { states: Iterable<SlotState> }) {
  const drawn = new Set(states);
  if (drawn.size === 0) return null;
  return (
    <ul className="kit-slot-legend" aria-label="Slot states">
      {SLOT_STATES.filter((state) => drawn.has(state)).map((state) => (
        <li key={state} data-state={state}>
          <span aria-hidden="true">
            <Slot state={state} text={LEGEND[state]} />
          </span>
          {LEGEND[state]}
        </li>
      ))}
    </ul>
  );
}

export function SlotRow({ label, count, text, entries, showLegend = true }: SlotRowProps) {
  return (
    <figure className="kit-slot-row" aria-label={text} title={text}>
      <figcaption className="kit-slot-row-heading">
        <span className="kit-slot-row-label">{label}</span>
        <span className="kit-slot-row-count">{count}</span>
      </figcaption>
      <span className="kit-slots">
        {entries.map(({ id, ...props }) => (
          <Slot key={id} {...props} />
        ))}
      </span>
      {showLegend && <SlotLegend states={entries.map((entry) => entry.state)} />}
    </figure>
  );
}
