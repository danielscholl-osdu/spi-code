// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { CanvasTone } from "../tone.js";

export interface ActionItem {
  type: string;
  label: string;
  tone?: CanvasTone;
  pendingLabel?: string;
  payload?: unknown;
  binding?: Record<string, unknown>;
  disabled?: boolean;
  reason?: string;
  confirm?: {
    irreversible?: boolean;
    subject?: string;
    label?: string;
    title?: string;
    body?: string;
    confirmLabel?: string;
    cancelLabel?: string;
  };
}
