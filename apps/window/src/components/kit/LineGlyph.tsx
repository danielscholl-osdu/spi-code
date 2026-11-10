// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { Fragment } from "react";
import { Slot, type SlotProps } from "./Slot.js";

export type LineStation = "sync-pr" | "release-upstream-pr" | "main" | "release";

const STATIONS: readonly LineStation[] = ["sync-pr", "release-upstream-pr", "main", "release"];
const LEGEND = "sync PR → release/upstream PR → main → release";

export interface LineGlyphProps extends SlotProps {
  station: LineStation;
  showLegend?: boolean;
}

export function LineGlyph({ station, state, text, origin, showLegend = false }: LineGlyphProps) {
  const at = STATIONS.indexOf(station);
  return (
    <span className="kit-line">
      <span className="kit-line-glyph" role="img" aria-label={text} title={text}>
        {STATIONS.map((name, index) => (
          <Fragment key={name}>
            {index > 0 && (
              <span
                className={`kit-line-connector${index <= at ? " kit-line-passed" : ""}`}
                aria-hidden="true"
              />
            )}
            <span data-station={name} aria-hidden="true">
              {index === at ? (
                <Slot state={state} text={text} {...(origin ? { origin } : {})} />
              ) : (
                <span className={index < at ? "kit-line-passed" : "kit-line-future"} />
              )}
            </span>
          </Fragment>
        ))}
      </span>
      {showLegend && <LineGlyphLegend />}
    </span>
  );
}

export function LineGlyphLegend() {
  return <span className="kit-line-legend">{LEGEND}</span>;
}
