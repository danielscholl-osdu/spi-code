// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { navigate } from "../../app/navigation.js";
import { selectionStore } from "../../panels/selection.js";

const FRAMES = 10;

/** Goes to Today and scrolls the first sweep's list into view once it has rendered. */
export function revealFirstSweep() {
  navigate({ kind: "today" });
  const step = (left: number) => {
    const list =
      document.querySelector<HTMLElement>(".today-first .sweep-sources") ??
      document.querySelector<HTMLElement>(".today-first");
    if (list) list.scrollIntoView?.({ block: "start" });
    else if (left > 0) requestAnimationFrame(() => step(left - 1));
  };
  requestAnimationFrame(() => step(FRAMES));
}

/** The freshness field's click: the list on first launch, the sweep's Evidence after it. */
export function openFreshness(snapshot: unknown) {
  if (snapshot) selectionStore.getState().openSweepEvidence();
  else revealFirstSweep();
}
