// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ReactNode } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { Lens } from "../../app/routes.js";
import { selectionStore } from "../../panels/selection.js";
import type { SelectionRow } from "../../panels/selection-rows.js";
import { useSelectionList } from "../../panels/useSelectionList.js";
import "./table.css";

type Sort = { column: string; descending: boolean } | null;
export const lensSortStore = createStore<Record<Lens, Sort>>(() => ({
  flow: null,
  repositories: null,
  horizon: null,
}));

export const blankCell = (text: string) => (text.trim() === "·" ? "" : text);

export type LensColumn<T> = {
  label: string;
  heading?: ReactNode;
  value(row: T): string;
  render?(row: T): ReactNode;
};

export type LensRow<T> = {
  reading: T;
  selection: SelectionRow;
  pointer: string;
  group?: string;
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function LensTable<T>({
  lens,
  rows,
  columns,
  onOpen,
}: {
  lens: Lens;
  rows: LensRow<T>[];
  columns: LensColumn<T>[];
  onOpen?(row: T): void;
}) {
  const sort = useStore(lensSortStore, (state) => state[lens]);
  const column = columns.find(({ label }) => label === sort?.column);
  const groups = [...new Set(rows.map(({ group }) => group))];
  const displayed = groups.flatMap((group) => {
    const members = rows.filter((row) => row.group === group);
    return column
      ? members.sort(
          (a, b) =>
            collator.compare(
              blankCell(column.value(a.reading)),
              blankCell(column.value(b.reading)),
            ) * (sort?.descending ? -1 : 1),
        )
      : members;
  });
  const open = (selection: SelectionRow) => {
    const row = displayed.find((row) => row.selection === selection);
    if (!row || !onOpen) return;
    if (selectionStore.getState().selected !== selection.id)
      selectionStore.getState().select(selection.id, selection);
    onOpen(row.reading);
  };
  const list = useSelectionList(
    displayed.map(({ selection }) => selection),
    open,
  );
  return (
    <div className="lens-table-scroll">
      <table className="lens-table" aria-label={lens} data-selection-list>
        <thead>
          <tr>
            {columns.map(({ label, heading }) => (
              <th
                key={label}
                scope="col"
                aria-sort={
                  sort?.column === label ? (sort.descending ? "descending" : "ascending") : "none"
                }
              >
                <button
                  type="button"
                  onClick={() =>
                    lensSortStore.setState({
                      [lens]: {
                        column: label,
                        descending: sort?.column === label && !sort.descending,
                      },
                    })
                  }
                >
                  {heading ?? label}
                  {sort?.column === label && (
                    <span aria-hidden>{sort.descending ? " ↓" : " ↑"}</span>
                  )}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody key={group ?? lens} data-group={group}>
            {group && (
              <tr className="lens-group">
                <th scope="rowgroup" colSpan={columns.length}>
                  {group}
                </th>
              </tr>
            )}
            {displayed
              .filter((row) => row.group === group)
              .map(({ reading, selection, pointer }) => (
                <tr key={selection.id} data-pointer={pointer} {...list.rowProps(selection)}>
                  {columns.map(({ label, value, render }, index) => {
                    const content = render ? render(reading) : blankCell(value(reading));
                    return (
                      <td key={label} data-column={label}>
                        {index === 0 && onOpen ? (
                          <button
                            type="button"
                            className="lens-name"
                            onClick={(event) => {
                              event.stopPropagation();
                              list.select(selection);
                              open(selection);
                            }}
                          >
                            {content}
                          </button>
                        ) : (
                          content
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}
