// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useState } from "react";
import { shiftShortcutLabel } from "../../app/shortcuts.js";
import { isFixedPin, togglePin, usePins } from "../../store/pins.js";
import { Icon } from "../icons/Icon.js";
import "./pin-control.css";

/**
 * The one pin control (PS-17): a hollow pin while unpinned, a filled pin while pinned that turns
 * to pin-off on hover or focus. None for the sidebar's fixed block.
 */
export function PinControl({
  pin,
  name,
  size = "top",
  shortcut = true,
  inList = false,
}: {
  pin: string;
  name: string;
  /** 24 px in the top row, 22 px in Find. */
  size?: "top" | "row";
  /** Whether ⌘⇧P acts where the control sits, and so belongs in its name. */
  shortcut?: boolean;
  /** Inside a listbox option: pointer only, so focus and the highlight stay where they are. */
  inList?: boolean;
}) {
  const pinned = usePins().includes(pin);
  const [fresh, setFresh] = useState(false);
  if (isFixedPin(pin)) return null;
  const label = `${pinned ? `Unpin ${name} from sidebar` : `Pin ${name} to sidebar`}${
    shortcut ? ` (${shiftShortcutLabel("p")})` : ""
  }`;
  return (
    <button
      type="button"
      className="pin-control"
      data-size={size}
      data-pinned={pinned}
      data-fresh={fresh || undefined}
      aria-label={label}
      title={label}
      {...(inList
        ? { tabIndex: -1, "aria-hidden": true, onMouseDown: (event) => event.preventDefault() }
        : {})}
      onClick={(event) => {
        event.stopPropagation();
        setFresh(true);
        togglePin(pin);
      }}
      onPointerLeave={() => setFresh(false)}
      onBlur={() => setFresh(false)}
    >
      <Icon name="pin" size={14} stroke={2} filled={pinned} className="pin-control-pin" />
      <Icon name="pinOff" size={14} stroke={2} className="pin-control-off" />
    </button>
  );
}
