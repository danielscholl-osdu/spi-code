// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";
import type { OpenSelection } from "../../app/navigation.js";
import type { BodyPlace, OpenedContent } from "../../components/opened-body/content.js";
import { itemContent, timed } from "../../components/place/opening.js";
import { type SelectionField, selectionRows } from "../../panels/selection-rows.js";
import { cellOpening } from "../line/cell-content.js";
import { columns } from "../line/cells.js";

export type ServiceOpening = { content: OpenedContent; fields: readonly SelectionField[] };

/**
 * What opens over a service page: an item (the repository's too), its Line cell, its release
 * review, its Upstream sync or one of its runs.
 */
export function serviceOpening(
  snapshot: ViewSnapshot,
  service: string,
  open: OpenSelection | null,
): ServiceOpening | undefined {
  if (!open) return undefined;
  const place: BodyPlace = {
    label: service,
    destination: { kind: "service", id: service },
    selection: open,
  };
  switch (open.kind) {
    case "item": {
      const content = itemContent(snapshot, open.id, place);
      return content && { content, fields: [] };
    }
    case "cell": {
      const cell = cellOpening(snapshot, open);
      const [, id] = open.id.split(":");
      const station = snapshot.stations
        .find((row) => row.service === service)
        ?.stations.find((station) => station.id === id);
      const label = columns.find((column) => column.id === id)?.label;
      return (
        cell && {
          content: cell.content,
          fields: station?.text && label ? [{ label, value: station.text }] : [],
        }
      );
    }
    case "station": {
      const [fork, id] = open.id.split(":");
      const station = snapshot.stations
        .find((row) => row.service === fork)
        ?.stations.find((station) => station.id === id);
      if (!station) return undefined;
      return {
        content: timed({
          title: `${service} · Release review`,
          place,
          subject: null,
          cause: station.text,
        }),
        fields: [],
      };
    }
    case "flow": {
      const row = selectionRows(snapshot).find(({ kind, id }) => kind === "flow" && id === open.id);
      if (!row) return undefined;
      return { content: { title: row.title, place, subject: null }, fields: row.fields ?? [] };
    }
    case "run": {
      const run = snapshot.services
        ?.find((row) => row.service === service)
        ?.runs.find(({ id }) => id === open.id);
      if (!run) return undefined;
      const source = { kind: "run" as const, label: `${run.workflow} run`, url: run.url };
      return {
        content: {
          title: [run.workflow, run.result].filter(Boolean).join(" · "),
          place,
          subject: null,
          primary: source,
          links: [source],
        },
        fields: [],
      };
    }
    default:
      return undefined;
  }
}
