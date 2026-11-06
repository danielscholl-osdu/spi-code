// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SidebarAttention } from "./sidebar/attention.js";
import "./attention.css";

export function AttentionDot({ dot }: { dot: SidebarAttention["dot"] }) {
  return dot ? (
    <span
      className="sidebar-attention-dot"
      data-attention={dot}
      role="img"
      aria-label={dot === "unread" ? "Unread" : dot.toUpperCase()}
    />
  ) : null;
}
