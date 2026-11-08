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

import { useRef, useState } from "react";
import { type ResizeControllerOptions, useResizeController } from "./resize-controller.js";
import "./pane-separator.css";

export type PaneSeparatorProps = ResizeControllerOptions & {
  /** The accessible name, such as "Resize sidebar". */
  label: string;
  /** The id of the pane this separator resizes. */
  controls?: string;
};

/**
 * An 8 px drag target straddling a pane's 1 px divider. Its parent is the pane,
 * positioned, with the divider as its border on `edge`.
 */
export function PaneSeparator({ label, controls, ...options }: PaneSeparatorProps) {
  const resize = useResizeController(options);
  const { handlers } = resize;
  const [hovered, setHovered] = useState(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const pointerPressed = useRef(false);
  const active = hovered || keyboardFocus || resize.dragging;
  const releasePointer = () => {
    pointerPressed.current = false;
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable resizer with a drag line; <hr> takes neither
    <div
      ref={handlers.ref}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={resize.width}
      aria-valuemin={resize.bounds.min}
      aria-valuemax={resize.bounds.max}
      className="pane-separator"
      data-edge={options.edge}
      data-active={active ? "" : undefined}
      data-dragging={resize.dragging ? "" : undefined}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onPointerDown={(event) => {
        pointerPressed.current = true;
        handlers.onPointerDown(event);
      }}
      onPointerMove={handlers.onPointerMove}
      onPointerUp={(event) => {
        releasePointer();
        handlers.onPointerUp(event);
      }}
      onPointerCancel={(event) => {
        releasePointer();
        handlers.onPointerCancel(event);
      }}
      onLostPointerCapture={handlers.onLostPointerCapture}
      onFocus={() => setKeyboardFocus(!pointerPressed.current)}
      onBlur={() => {
        releasePointer();
        setKeyboardFocus(false);
      }}
      onKeyDown={(event) => {
        setKeyboardFocus(true);
        handlers.onKeyDown(event);
      }}
      onDoubleClick={handlers.onDoubleClick}
    >
      <span className="pane-separator-line" aria-hidden="true" />
    </div>
  );
}
