// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { SelectionRow, TodayGroup } from "../../panels/selection-rows.js";

/** Width and row membership decide folds; selecting under a sheet never reflows. */
export function useFold<T extends { id: string; itemIds: readonly string[] }>(
  rows: readonly T[],
  selected: string | null,
  aliases: (row: T) => readonly string[] = () => [],
) {
  const current = useRef({ rows, selected, aliases });
  current.current = { rows, selected, aliases };
  const choose = useCallback((previous: readonly string[] | null = null) => {
    const { rows, selected, aliases } = current.current;
    if (window.innerWidth > 740 || rows.length <= 3) return null;
    const ids = new Set(rows.map(({ id }) => id));
    const membership = new Set(previous?.filter((id) => ids.has(id)));
    for (const { id } of rows) {
      if (membership.size === 3) break;
      membership.add(id);
    }
    const kept = rows.filter(({ id }) => membership.has(id)).map(({ id }) => id);
    const chosen = rows.find(
      (row) => selected !== null && [row.id, ...row.itemIds, ...aliases(row)].includes(selected),
    );
    if (chosen && !kept.includes(chosen.id)) kept[2] = chosen.id;
    return kept;
  }, []);
  const [kept, setKept] = useState(choose);
  const rowIds = JSON.stringify(rows.map(({ id }) => id));
  const previousRowIds = useRef(rowIds);
  useLayoutEffect(() => {
    if (previousRowIds.current === rowIds) return;
    previousRowIds.current = rowIds;
    setKept((previous) => choose(previous));
  }, [choose, rowIds]);
  useLayoutEffect(() => {
    let width = window.innerWidth;
    const resize = () => {
      if (width === window.innerWidth) return;
      width = window.innerWidth;
      setKept(choose());
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [choose]);
  const visible = kept ? rows.filter(({ id }) => kept.includes(id)) : rows;
  const hidden = kept ? rows.filter(({ id }) => !kept.includes(id)) : [];
  return {
    visible,
    hidden: hidden.length > 0,
    more: new Set(hidden.flatMap(({ itemIds }) => [...itemIds])).size,
  };
}

export function More({
  group,
  count,
  hasMore,
  row,
  select,
}: {
  group: TodayGroup;
  count: number;
  hasMore: boolean;
  row: SelectionRow;
  select: (row: SelectionRow) => void;
}) {
  return hasMore ? (
    <button
      type="button"
      className="today-more"
      data-group={group}
      data-selection-id={row.id}
      aria-label={`${count > 0 ? `${count} more` : "More"}: ${row.title}`}
      onClick={() => select(row)}
    >
      {count > 0 ? `${count} more` : "More"} ›
    </button>
  ) : null;
}
