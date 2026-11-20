// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { AccessMode } from "./access-mode.js";

const LABELS: Record<AccessMode, string> = {
  supervised: "Supervised",
  "auto-accept-edits": "Auto-accept edits",
};

export function AccessModeChip({ mode }: { mode: AccessMode }) {
  return (
    <span className="thread-chip thread-access-mode" data-access-mode={mode}>
      {LABELS[mode]}
    </span>
  );
}
