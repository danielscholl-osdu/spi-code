// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { CSSProperties, MouseEvent } from "react";
import { openEvidence, routeHash } from "../../app/navigation.js";
import type { FleetCells, FlowCell } from "./fleet.js";
import "./fleet-flow.css";

const follow = (open: () => void) => (event: MouseEvent) => {
  event.preventDefault();
  open();
};

function Readout({ cell }: { cell: FlowCell }) {
  const go = cell.kind === "link" || cell.kind === "not-read";
  return (
    <>
      <span className="fleet-label">{cell.label}</span>
      {cell.kind === "dot" ? (
        <span className="fleet-value fleet-value--none" role="img" aria-label="None">
          ·
        </span>
      ) : cell.kind === "not-read" ? (
        <span className="fleet-value fleet-value--unread" role="img" aria-label="Not read">
          ⌀ <span aria-hidden="true">›</span>
        </span>
      ) : (
        <span className={cell.bad ? "fleet-value fleet-value--bad" : "fleet-value"}>
          {cell.tick && (
            <span className="fleet-tick" aria-hidden="true">
              ✓{" "}
            </span>
          )}
          {cell.value}
          {cell.more && " "}
          {cell.more && <span className="fleet-more">{cell.more}</span>}
          {go && (
            <span className="fleet-go" aria-hidden="true">
              {" "}
              ›
            </span>
          )}
        </span>
      )}
      {cell.sub && <span className="fleet-sub">{cell.sub}</span>}
    </>
  );
}

function Cell({ cell, as, big }: { cell: FlowCell; as: "station" | "door"; big?: boolean }) {
  const className = [
    "fleet-cell",
    big && "fleet-cell--big",
    cell.tone && `fleet-cell--${cell.tone}`,
  ]
    .filter(Boolean)
    .join(" ");
  const attributes = {
    className,
    title: cell.title,
    [`data-${as}`]: cell.id,
    "data-kind": cell.kind,
    "data-target": cell.target,
  };
  if (cell.kind === "filter" && cell.open)
    return (
      <button
        type="button"
        {...attributes}
        aria-pressed={cell.pressed ?? false}
        onClick={cell.open}
      >
        <Readout cell={cell} />
      </button>
    );
  if ((cell.kind === "link" || cell.kind === "not-read") && cell.open && cell.href)
    return (
      <a {...attributes} href={cell.href} onClick={follow(cell.open)}>
        <Readout cell={cell} />
      </a>
    );
  return (
    <span {...attributes}>
      <Readout cell={cell} />
    </span>
  );
}

/** A cell with its place in the flow and, when it has a value and a gap, its ⌀ › chip. */
function Slot({
  cell,
  as,
  big,
  arrow,
}: {
  cell: FlowCell;
  as: "station" | "door";
  big?: boolean;
  arrow?: boolean;
}) {
  const plain = cell.kind !== "filter";
  const style = plain ? ({ "--l": cell.label.length } as CSSProperties) : undefined;
  return (
    <span className={plain ? "fleet-slot fleet-slot--plain" : "fleet-slot"} style={style}>
      <Cell cell={cell} as={as} {...(big ? { big } : {})} />
      {cell.gap && (
        <a
          className="fleet-gap"
          href={routeHash({ kind: "evidence" })}
          title={`${cell.gap} · opens Evidence`}
          aria-label={`${cell.gap}, open Evidence`}
          onClick={follow(() => openEvidence(null))}
        >
          <span>⌀</span> <span aria-hidden="true">›</span>
        </a>
      )}
      {arrow && (
        <span className="fleet-arrow" aria-hidden="true">
          →
        </span>
      )}
    </span>
  );
}

/** Under the flow: what was not read, by name, or by count with the names on hover past four. */
function NotReadLine({ names }: { names: readonly string[] }) {
  const many = names.length > 4;
  return (
    <p className="today-not-read fleet-not-read" {...(many ? { title: names.join("\n") } : {})}>
      ⌀ {many ? `Not read on ${names.length} forks` : `Not read: ${names.join(", ")}`} ·{" "}
      <a href={routeHash({ kind: "evidence" })} onClick={follow(() => openEvidence(null))}>
        Evidence ›
      </a>
    </p>
  );
}

/** Today's fleet flow: stations to Main, the doors straight into main, then Environment. */
export function FleetFlow({ cells }: { cells: FleetCells }) {
  return (
    <div className="fleet">
      {/* biome-ignore lint/a11y/useSemanticElements: a grid of stations, not form controls a fieldset would group */}
      <div className="fleet-flow" role="group" aria-label={cells.label}>
        <div className="fleet-lanes">
          <div className="fleet-lane fleet-lane--stations">
            {cells.stations.map((cell, at) => (
              <Slot key={cell.id} cell={cell} as="station" arrow={at < cells.stations.length - 1} />
            ))}
          </div>
          <div className="fleet-lane fleet-lane--doors">
            <span className="fleet-legend">Straight into main</span>
            {cells.doors.map((cell) => (
              <Slot key={cell.id} cell={cell} as="door" />
            ))}
          </div>
        </div>
        <div className="fleet-join" aria-hidden="true">
          <span>→</span>
          <span>→</span>
        </div>
        <Slot cell={cells.main} as="station" big />
        <span className="fleet-sep" aria-hidden="true">
          →
        </span>
        <Slot cell={cells.environment} as="station" big />
      </div>
      {cells.notRead.length > 0 && <NotReadLine names={cells.notRead} />}
    </div>
  );
}
