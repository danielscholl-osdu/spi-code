// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT
//
// Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export const KEY_STEP = 16;
export const KEY_STEP_LARGE = 64;
const DRAG_THRESHOLD = 2;

export type ResizeEdge = "left" | "right";

export type ResizeBounds = { readonly min: number; readonly max: number };

export type ResizeControllerOptions = {
  /** The pane border the separator sits on: "right" grows to the right (sidebar), "left" grows to the left (right panel). */
  edge: ResizeEdge;
  /** The width the pane is displayed at now. */
  width: number;
  min: number;
  max: number;
  /** Where a double-click returns the pane. */
  defaultWidth: number;
  /** Widest a drag or arrow step may take the pane, such as the width that leaves the centre 520 px. */
  stop?: number;
  /** Each width during a drag, for live reflow. */
  onResize?: (width: number) => void;
  /** A finished width: a drag's end, an arrow step or a double-click reset. */
  onResizeEnd: (width: number) => void;
};

export function resizeBounds(min: number, max: number, stop?: number): ResizeBounds {
  const ceiling = stop === undefined ? max : Math.min(max, stop);
  return { min, max: Math.max(min, ceiling) };
}

export function clampWidth(width: number, bounds: ResizeBounds): number {
  return Math.max(bounds.min, Math.min(bounds.max, Math.round(width)));
}

/** The signed change in pane width an arrow key asks for, or null for any other key. */
export function keyDelta(key: string, shift: boolean, edge: ResizeEdge): number | null {
  const step = shift ? KEY_STEP_LARGE : KEY_STEP;
  const rightward = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0;
  if (rightward === 0) return null;
  return rightward * step * (edge === "right" ? 1 : -1);
}

type ActiveDrag = {
  target: HTMLElement;
  pointerId: number;
  startX: number;
  pendingX: number;
  startWidth: number;
  width: number;
  moved: boolean;
  frame: number | null;
  onBlur: () => void;
};

function createController(
  latest: RefObject<ResizeControllerOptions>,
  setDragWidth: (width: number | null) => void,
) {
  let drag: ActiveDrag | null = null;

  const bounds = () => {
    const { min, max, stop } = latest.current;
    return resizeBounds(min, max, stop);
  };

  const flush = (limits: ResizeBounds = bounds()) => {
    const active = drag;
    if (!active) return;
    const sign = latest.current.edge === "right" ? 1 : -1;
    const delta = active.moved ? (active.pendingX - active.startX) * sign : 0;
    const width = clampWidth(active.startWidth + delta, limits);
    if (width === active.width) return;
    active.width = width;
    setDragWidth(width);
    latest.current.onResize?.(width);
  };

  const finish = (commit: boolean) => {
    const active = drag;
    if (!active) return;
    if (active.frame !== null) cancelAnimationFrame(active.frame);
    window.removeEventListener("blur", active.onBlur);
    if (commit) flush();
    // Releasing capture can dispatch lostpointercapture synchronously.
    drag = null;
    try {
      if (active.target.hasPointerCapture(active.pointerId)) {
        active.target.releasePointerCapture(active.pointerId);
      }
    } catch {}
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    setDragWidth(null);
    const changed = active.width !== active.startWidth;
    if (commit && (active.moved || changed)) latest.current.onResizeEnd(active.width);
    else if (!commit && changed) latest.current.onResize?.(active.startWidth);
  };

  const end = (event: PointerEvent<HTMLElement>, usePosition: boolean) => {
    const active = drag;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (usePosition) {
      active.pendingX = event.clientX;
      if (Math.abs(event.clientX - active.startX) > DRAG_THRESHOLD) active.moved = true;
    }
    finish(true);
  };

  return {
    ref: (node: HTMLElement | null) => (node === null ? undefined : () => finish(false)),
    /** Re-clamps a drag in progress when its bounds or stop change. */
    refresh(limits: ResizeBounds) {
      flush(limits);
    },
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (event.button !== 0 || drag) return;
      const target = event.currentTarget;
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        return;
      }
      event.preventDefault();
      // Leaving the window mid-drag finishes where the pointer last was.
      const onBlur = () => finish(true);
      window.addEventListener("blur", onBlur);
      const width = clampWidth(latest.current.width, bounds());
      drag = {
        target,
        pointerId: event.pointerId,
        startX: event.clientX,
        pendingX: event.clientX,
        startWidth: width,
        width,
        moved: false,
        frame: null,
        onBlur,
      };
      setDragWidth(width);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const active = drag;
      if (!active || active.pointerId !== event.pointerId) return;
      event.preventDefault();
      active.pendingX = event.clientX;
      if (Math.abs(event.clientX - active.startX) > DRAG_THRESHOLD) active.moved = true;
      if (active.frame !== null) return;
      active.frame = requestAnimationFrame(() => {
        active.frame = null;
        flush();
      });
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => end(event, true),
    onPointerCancel: (event: PointerEvent<HTMLElement>) => end(event, false),
    onLostPointerCapture: (event: PointerEvent<HTMLElement>) => end(event, false),
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      if (drag) return;
      const { edge, onResizeEnd } = latest.current;
      const delta = keyDelta(event.key, event.shiftKey, edge);
      if (delta === null) return;
      event.preventDefault();
      const width = clampWidth(latest.current.width, bounds());
      const next = clampWidth(width + delta, bounds());
      if (next !== width) onResizeEnd(next);
    },
    onDoubleClick() {
      if (drag) return;
      const { min, max, defaultWidth, onResizeEnd } = latest.current;
      onResizeEnd(clampWidth(defaultWidth, { min, max }));
    },
  };
}

export type ResizeHandlers = ReturnType<typeof createController>;

/**
 * Drives one pane edge by pointer drag, arrow keys and double-click. Options are
 * read when each event arrives, and a drag in progress re-clamps when the bounds
 * or the stop change. The width it returns and announces always lies within the
 * bounds. A double-click reports the default within min and max, ignoring the
 * stop: it is the preferred width, and the width budget decides the displayed one.
 */
export function useResizeController(options: ResizeControllerOptions): {
  width: number;
  dragging: boolean;
  bounds: ResizeBounds;
  handlers: ResizeHandlers;
} {
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  // Created once: `ref` keeps its identity, or a re-render mid-drag would run its cleanup.
  const [handlers] = useState(() => createController(latest, setDragWidth));
  const { min, max, stop } = options;
  useLayoutEffect(() => handlers.refresh(resizeBounds(min, max, stop)), [handlers, min, max, stop]);
  const bounds = resizeBounds(min, max, stop);
  return {
    width: dragWidth ?? clampWidth(options.width, bounds),
    dragging: dragWidth !== null,
    bounds,
    handlers,
  };
}
