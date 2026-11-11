// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useLayoutEffect, useRef } from "react";
import { selectionStore } from "../../panels/selection.js";

/** Capture before Detail changes the centre; resize then scrolls around the same selected row. */
export function useTodayAnchor() {
  const frame = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const body = frame.current;
    const scroller = body?.closest<HTMLElement>(".today");
    if (!body || !scroller) return;
    let row: HTMLElement | undefined;
    let top = 0;
    const capture = () => {
      const selected = selectionStore.getState().selected;
      row = selected
        ? [
            ...body.querySelectorAll<HTMLElement>(
              "[data-item-id], [data-item-ids], [data-selection-id], [data-theme], [data-inspect], [data-pr-inspect]",
            ),
          ].find((element) =>
            [
              element.dataset.itemId,
              element.dataset.selectionId,
              element.dataset.inspect,
              element.dataset.prInspect,
              ...(element.dataset.itemIds?.split(" ") ?? []),
              ...(element.dataset.theme ? [`theme:${element.dataset.theme}`] : []),
            ].includes(selected),
          )
        : undefined;
      if (row) top = row.getBoundingClientRect().top;
    };
    const remember = () => {
      if (row) top = row.getBoundingClientRect().top;
    };
    const unsubscribe = selectionStore.subscribe((next, previous) => {
      if (next.selected !== previous.selected) capture();
    });
    capture();
    const observer = new ResizeObserver(() => {
      if (!row?.isConnected) return;
      scroller.scrollTop += row.getBoundingClientRect().top - top;
      remember();
    });
    observer.observe(body);
    scroller.addEventListener("scroll", remember, { passive: true });
    return () => {
      observer.disconnect();
      unsubscribe();
      scroller.removeEventListener("scroll", remember);
    };
  }, []);
  return frame;
}
