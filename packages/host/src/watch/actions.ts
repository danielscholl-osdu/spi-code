// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { ActionItemSchema, type ActionItem as AppAction } from "@spi-code/contracts";
import type { ActionItem } from "@spi-code/core";

export function appActions(items: readonly ActionItem[]): AppAction[] {
  const reserved = new Set(items.map((item) => item.type));
  const assigned = new Set<string>();
  return items.map((item) => {
    let id = item.type;
    if (assigned.has(id)) {
      let suffix = 2;
      do {
        id = `${item.type}-${suffix++}`;
      } while (reserved.has(id) || assigned.has(id));
    }
    assigned.add(id);
    const pendingError =
      item.pendingLabel !== undefined && item.pendingLabel.length > 40
        ? "pendingLabel exceeds 40 characters"
        : undefined;
    const reason =
      pendingError === undefined
        ? item.reason
        : item.reason === undefined
          ? pendingError
          : `${item.reason}; ${pendingError}`;
    if (item.confirm?.irreversible && !item.confirm.subject?.trim()) {
      throw new TypeError(`${item.type}: irreversible action requires a subject`);
    }
    return ActionItemSchema.parse({
      id,
      label: item.label,
      disabledReason: "writes arrive at M4",
      ...(reason === undefined ? {} : { eligibilityReason: reason }),
    });
  });
}
