// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/** The most rows the list mounts at once, whatever the thread's length. */
export const ROW_BUDGET = 60;
const OVERSCAN = 8;
const FALLBACK_VIEWPORT = 800;
const BOTTOM_SLACK = 24;

export interface VirtualListProps<T> {
  items: readonly T[];
  itemKey(item: T): string;
  estimate(item: T): number;
  children(item: T): ReactNode;
  className?: string;
  label: string;
  busy?: boolean;
}

function firstAtOrAfter(offsets: readonly number[], y: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((offsets[mid + 1] ?? 0) <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A windowed list that follows its end while the reader is at the end, as a timeline does. */
export function VirtualList<T>(props: VirtualListProps<T>) {
  const { items, itemKey, estimate } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const [measured, setMeasured] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(FALLBACK_VIEWPORT);
  const following = useRef(true);

  const offsets = useMemo(() => {
    void measured;
    const out = [0];
    for (const item of items)
      out.push((out.at(-1) ?? 0) + (heights.current.get(itemKey(item)) ?? estimate(item)));
    return out;
  }, [items, itemKey, estimate, measured]);
  const total = offsets.at(-1) ?? 0;

  const top = following.current ? Math.max(0, total - viewport) : scrollTop;
  let start = Math.max(0, firstAtOrAfter(offsets, top) - OVERSCAN);
  let end = Math.min(items.length, firstAtOrAfter(offsets, top + viewport) + 1 + OVERSCAN);
  if (end - start > ROW_BUDGET) {
    if (following.current) start = end - ROW_BUDGET;
    else end = start + ROW_BUDGET;
  }

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && following.current) element.scrollTop = total;
  });

  useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() =>
      setViewport(element.clientHeight || FALLBACK_VIEWPORT),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const rowObserver = useMemo(
    () =>
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((records) => {
            let changed = false;
            for (const record of records) {
              const key = (record.target as HTMLElement).dataset.rowKey;
              const height = (record.target as HTMLElement).offsetHeight;
              if (key && height && heights.current.get(key) !== height) {
                heights.current.set(key, height);
                changed = true;
              }
            }
            if (changed) setMeasured((n) => n + 1);
          }),
    [],
  );
  useEffect(() => () => rowObserver?.disconnect(), [rowObserver]);
  const observeRow = useCallback(
    (element: HTMLDivElement | null) => {
      if (element) rowObserver?.observe(element);
    },
    [rowObserver],
  );

  return (
    <div
      ref={scroller}
      className={props.className}
      role="log"
      aria-label={props.label}
      aria-busy={props.busy || undefined}
      onScroll={(event) => {
        const element = event.currentTarget;
        following.current =
          element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_SLACK;
        setScrollTop(element.scrollTop);
      }}
    >
      <div style={{ position: "relative", height: total }}>
        <div style={{ position: "absolute", top: offsets[start] ?? 0, left: 0, right: 0 }}>
          {items.slice(start, end).map((item) => {
            const key = itemKey(item);
            return (
              <div key={key} ref={observeRow} data-row-key={key} className="thread-row">
                {props.children(item)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
