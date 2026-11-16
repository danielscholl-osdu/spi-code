// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { isFixedPin, togglePin, usePins } from "../store/pins.js";

/** Pin or Unpin beside a place's title, for the sidebar's Pinned list; none on the sidebar's fixed block. */
export function PlacePin({ pin, name }: { pin: string; name: string }) {
  const pinned = usePins().includes(pin);
  if (isFixedPin(pin)) return null;
  return (
    <button
      type="button"
      className="place-pin"
      aria-label={`${pinned ? "Unpin" : "Pin"} ${name}`}
      onClick={() => togglePin(pin)}
    >
      {pinned ? "Unpin" : "Pin"}
    </button>
  );
}
