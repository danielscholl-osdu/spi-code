// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { PlaceRow, ViewSnapshot } from "@spi-code/contracts";
import { selectionStore } from "../../panels/selection.js";
import { selectionRows } from "../../panels/selection-rows.js";
import { plainTitle } from "../../text.js";
import { TimedText } from "../../time.js";
import { Chip } from "../kit/Chip.js";
import "./place.css";

export function freshItemIds(snapshot: ViewSnapshot | undefined, place: PlaceRow["place"]) {
  return snapshot?.briefing.places?.find((row) => row.place === place)?.fresh?.itemIds ?? [];
}

export function FreshChip({ id }: { id: string }) {
  return (
    <span data-fresh-item={id}>
      <Chip label="new" text="New since your last look" tone="accent" />
    </span>
  );
}

/** Keeps fresh items reachable when the reading folds them or the place uses a grid. */
export function FreshItems({
  snapshot,
  place,
  shown = [],
  onSelect,
}: {
  snapshot: ViewSnapshot | undefined;
  place: PlaceRow["place"];
  shown?: readonly string[] | undefined;
  onSelect?: ((id: string) => void) | undefined;
}) {
  const fresh = freshItemIds(snapshot, place);
  if (!snapshot || !fresh.length) return null;
  const items = [...snapshot.briefing.focus, ...snapshot.briefing.rest];
  const rows = selectionRows(snapshot);
  const missing = [...new Set(fresh)].flatMap((id) => {
    const item = items.find((item) => item.id === id);
    const row = rows.find((row) => row.kind === "queue" && row.id === id);
    return item && row && !shown.includes(id) ? [{ item, row }] : [];
  });
  if (!missing.length) return null;
  return (
    <ul className="place-fresh-items" aria-label="New items">
      {missing.map(({ item, row }) => (
        <li className="place-item" key={item.id} data-item-id={item.id}>
          <span className="place-rank" data-rung={item.rung}>
            P{item.rung}
          </span>
          <div className="place-item-body">
            <button
              type="button"
              className="place-item-content"
              data-selection-id={item.id}
              onClick={() => {
                if (onSelect) return onSelect(item.id);
                selectionStore.getState().select(item.id, row);
                selectionStore.getState().setTab("detail");
              }}
            >
              <span className="place-item-title">
                {item.scope}: <TimedText text={plainTitle(item.title)} hint={false} />
              </span>
            </button>
            <FreshChip id={item.id} />
          </div>
        </li>
      ))}
    </ul>
  );
}
