// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";
import type { Destination } from "./navigation.js";
import type { Reach } from "./reachability.test-helper.js";

const freshDestination = (place: string): Destination => {
  switch (place) {
    case "environment":
      return { kind: "environment" };
    case "engineering":
      return { kind: "engineering-system" };
    default:
      return { kind: "security" };
  }
};

export const SECURITY_FRESH_ALERT_GONE =
  "Security draws rules, not the reading's alerts, so a new alert has no chip of its own; a new Briefing item keeps its chip under the page";

/** Fresh ids have a visible chip at their place. */
export function placeFreshCases(snapshot: ViewSnapshot): Reach[] {
  const items = new Set(
    [...snapshot.briefing.focus, ...snapshot.briefing.rest].map(({ id }) => id),
  );
  return (snapshot.briefing.places ?? []).flatMap((row, index) =>
    (row.place === "line" ? [] : (row.fresh?.itemIds ?? [])).map((id, at) => ({
      ...(row.place === "security" && !items.has(id) ? { exempt: SECURITY_FRESH_ALERT_GONE } : {}),
      pointer: `/briefing/places/${index}/fresh/itemIds/${at}`,
      value: id,
      home: {
        name: `Fresh items · ${row.place}`,
        start: {
          name: row.place,
          surface: freshDestination(row.place).kind,
          route: freshDestination(row.place),
        },
      },
      selector: `[data-fresh-item=${JSON.stringify(id)}]`,
      attribute: "data-fresh-item",
    })),
  );
}
