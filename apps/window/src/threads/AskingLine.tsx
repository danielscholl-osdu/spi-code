// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { LANDS_IN_LABELS } from "./LandsInChip.js";

/** Where a draft's work lands, under its composer: Asking, which changes nothing. */
export function AskingLine() {
  return <p className="thread-asking">{LANDS_IN_LABELS.asking}</p>;
}
