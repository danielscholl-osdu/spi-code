// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ServiceHomeStation } from "@spi-code/contracts";
import "./flow.css";

export type FlowState = ServiceHomeStation["state"];

export type FlowStation = {
  id: string;
  label: string;
  state: FlowState;
  word: string;
  line?: string | undefined;
  /** Something is moving into this station, so the edge before it moves. */
  inTransit?: boolean | undefined;
  /** Without it the station is not a button. */
  onOpen?: (() => void) | undefined;
};

export type FlowDoor = {
  id: string;
  label: string;
  word: string;
  onOpen?: (() => void) | undefined;
};

const MARKS: Readonly<Record<FlowState, { glyph: string; say: string }>> = {
  stopped: { glyph: "✕", say: "blocked" },
  "waiting-on-person": { glyph: "!", say: "waiting on you" },
  "in-progress": { glyph: "◐", say: "running" },
  "waiting-on-clock": { glyph: "◷", say: "waits on time" },
  unread: { glyph: "⌀", say: "not read" },
  ready: { glyph: "·", say: "fine" },
  green: { glyph: "✓", say: "green" },
};

function Station({ station, place }: { station: FlowStation; place: "top" | "join" }) {
  const { glyph, say } = MARKS[station.state];
  const inner = (
    <>
      <span className="flow-label">
        <span className="flow-glyph" aria-hidden="true">
          {glyph}
        </span>
        {station.label}
        <span className="flow-say">, {say}</span>
      </span>
      <span className="flow-word">{station.word}</span>
      {station.line && <span className="flow-line">{station.line}</span>}
    </>
  );
  const props = {
    className: "flow-station",
    "data-station": station.id,
    "data-state": station.state,
    "data-place": place,
  };
  return station.onOpen ? (
    <button type="button" {...props} onClick={station.onOpen}>
      {inner}
    </button>
  ) : (
    <div {...props}>{inner}</div>
  );
}

/**
 * How code reaches a fork's main: the stations before the last in a row, the doors straight into
 * main beneath them, and both joining the last station.
 */
export function Flow({
  label,
  stations,
  doors,
}: {
  label: string;
  stations: readonly FlowStation[];
  doors: readonly FlowDoor[];
}) {
  const before = stations.slice(0, -1);
  const last = stations.at(-1);
  return (
    <div className="flow-wrap">
      {/* biome-ignore lint/a11y/useSemanticElements: a grid of stations, not form controls a fieldset would group */}
      <div className="flow" role="group" aria-label={label}>
        <div className="flow-top">
          {before.map((station, index) => [
            index > 0 && (
              <span
                key={`${station.id}-edge`}
                className="flow-edge"
                data-moving={station.inTransit || undefined}
                aria-hidden="true"
              />
            ),
            <Station key={station.id} station={station} place="top" />,
          ])}
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: a grid of doors, not form controls a fieldset would group */}
        <div className="flow-direct" aria-label="Straight into main" role="group">
          <span className="flow-direct-label" aria-hidden="true">
            Straight into main
          </span>
          {doors.map((door) =>
            door.onOpen ? (
              <button
                type="button"
                key={door.id}
                className="flow-door"
                data-door={door.id}
                onClick={door.onOpen}
              >
                <span className="flow-door-label">{door.label}</span>
                <span className="flow-door-word">{door.word}</span>
              </button>
            ) : (
              <span key={door.id} className="flow-door" data-door={door.id}>
                <span className="flow-door-label">{door.label}</span>
                <span className="flow-door-word">{door.word}</span>
              </span>
            ),
          )}
        </div>
        <svg
          className="flow-join"
          viewBox="0 0 44 100"
          preserveAspectRatio="none"
          aria-hidden="true"
          data-moving={last?.inTransit || undefined}
        >
          <path d="M0 24 C26 24,18 50,44 50" />
          <path d="M0 80 C26 80,18 50,44 50" />
        </svg>
        {last && <Station station={last} place="join" />}
      </div>
    </div>
  );
}
