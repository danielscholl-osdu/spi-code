// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SecurityByRule, SecurityLaneId, SecurityRuleRow } from "@spi-code/contracts";
import type { SecurityInput } from "./classify.js";

export type SecurityRuleHead = Omit<SecurityRuleRow, "opened">;

/** The chosen lane read by rule: its summary line and one row per rule or package. */
export function securityByRule(
  _input: SecurityInput,
  _lane: SecurityLaneId,
): Omit<SecurityByRule, "rules"> & { rules: SecurityRuleHead[] } {
  return { summary: [], heading: [], tickMax: 0, barMax: 0, rules: [] };
}
