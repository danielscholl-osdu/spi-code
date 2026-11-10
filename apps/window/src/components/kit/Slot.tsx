// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import "./kit.css";

export type SlotState = "empty" | "occupied" | "done" | "waiting" | "broken" | "unknown";
export type Origin = "system" | "upstream";

export interface SlotProps {
  state: SlotState;
  /** The complete sentence supplied by core, shared by hover and accessible name. */
  text: string;
  origin?: Origin;
}

export const SLOT_STATES: readonly SlotState[] = [
  "empty",
  "occupied",
  "done",
  "waiting",
  "broken",
  "unknown",
];

const SHAPES: Record<SlotState, string> = {
  empty: "hollow-circle",
  occupied: "filled-circle",
  done: "checked-circle",
  waiting: "triangle",
  broken: "diamond",
  unknown: "dotted-circle",
};

export function Slot({ state, text, origin = "system" }: SlotProps) {
  return (
    <span
      className={`kit-slot kit-slot--${state}${state === "waiting" && origin === "upstream" ? " kit-slot--upstream" : ""}`}
      data-shape={SHAPES[state]}
      role="img"
      aria-label={text}
      title={text}
    >
      <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        {state === "waiting" ? (
          <path d="M6 1 12 11H0Z" fill="currentColor" />
        ) : state === "broken" ? (
          <path d="m6 0 6 6-6 6-6-6Z" fill="currentColor" />
        ) : (
          <circle
            cx="6"
            cy="6"
            r={state === "done" ? 5.5 : 4}
            fill={state === "empty" || state === "unknown" ? "none" : "currentColor"}
            stroke="currentColor"
            strokeWidth="1.4"
          />
        )}
        {state === "done" && <path className="kit-slot-check" d="m3 6 2 2 4-4" />}
        {state === "unknown" && <circle cx="6" cy="6" r="1.4" fill="currentColor" />}
      </svg>
    </span>
  );
}
