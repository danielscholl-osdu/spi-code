// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { ContextMenu } from "@base-ui/react/context-menu";
import type { KeyboardEvent, ReactElement } from "react";
import { togglePin, usePins } from "../../store/pins.js";
import "./pin-menu.css";

/** Shift-F10 and the ContextMenu key open a context menu from the keyboard. */
export function isContextMenuKey(event: Pick<KeyboardEvent, "key" | "shiftKey">) {
  return event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
}

function openFromKeyboard(event: KeyboardEvent<HTMLElement>) {
  if (!isContextMenuKey(event)) return;
  event.preventDefault();
  const target = event.target instanceof HTMLElement ? event.target : event.currentTarget;
  const box = target.getBoundingClientRect();
  target.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: box.left,
      clientY: box.bottom,
    }),
  );
}

/**
 * A service's context menu (PS-08): one item, Pin or Unpin. `render` is the element the menu
 * opens on, by right click, long press, Shift-F10 or the ContextMenu key; Escape closes it.
 */
export function PinMenu({ service, render }: { service: string; render: ReactElement }) {
  const pinned = usePins().includes(service);
  const label = `${pinned ? "Unpin" : "Pin"} ${service}`;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger render={render} onKeyDown={openFromKeyboard} />
      <ContextMenu.Portal>
        <ContextMenu.Positioner>
          <ContextMenu.Popup
            className="pin-menu"
            data-pin-menu={service}
            onClick={(event) => event.stopPropagation()}
          >
            <ContextMenu.Item className="pin-menu-item" onClick={() => togglePin(service)}>
              {label}
            </ContextMenu.Item>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
