// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { KeyboardEvent } from "react";
import { useStore } from "zustand";
import { type SelectionStore, selectionStore } from "./selection.js";
import type { SelectionRow } from "./selection-rows.js";

/**
 * Pass rows in displayed (sorted) order. Mark the list container data-selection-list.
 * Spread rowProps(row) onto a focusable row/option;
 * open handles Enter/double-click (navigate to its thing, or open its external link).
 * Route membership and middle-frame scroll are owned by Shell, not the list.
 */
export function useSelectionList(
  rows: readonly SelectionRow[],
  open?: (row: SelectionRow) => void,
  store: SelectionStore = selectionStore,
) {
  const selected = useStore(store, (state) => state.selected);
  const selectedRow = useStore(store, (state) => state.row);
  const matches = rows.filter((row) => row.id === selected);
  // Several readings can fold into one inspect id; their source pointers distinguish the rows.
  const active =
    matches.find(
      (row) =>
        row.kind === selectedRow?.kind &&
        row.prefixes?.join("|") === selectedRow?.prefixes?.join("|"),
    ) ?? matches[0];
  const select = (row: SelectionRow) => store.getState().select(row.id, row);
  return {
    selected,
    select,
    rowProps(row: SelectionRow) {
      return {
        "data-selection-id": row.id,
        "aria-selected": active === row,
        tabIndex: row === (active ?? rows[0]) ? 0 : -1,
        onClick: () => select(row),
        onDoubleClick: () => open?.(row),
        onKeyDown(event: KeyboardEvent<HTMLElement>) {
          if (event.target !== event.currentTarget || event.defaultPrevented) return;
          if (event.key === "Enter") {
            event.preventDefault();
            select(row);
            open?.(row);
            return;
          }
          const direction = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
          if (!direction) return;
          event.preventDefault();
          const nextIndex = Math.max(0, Math.min(rows.length - 1, rows.indexOf(row) + direction));
          const next = rows[nextIndex];
          if (!next) return;
          const siblings =
            event.currentTarget.closest("[data-selection-list]") ??
            event.currentTarget.parentElement;
          const target = siblings?.querySelectorAll<HTMLElement>("[data-selection-id]")[nextIndex];
          target?.focus({ preventScroll: true });
          target?.scrollIntoView?.({ block: "nearest" });
          select(next);
        },
      };
    },
  };
}
