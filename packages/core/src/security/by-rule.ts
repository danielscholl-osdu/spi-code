// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SecurityByRule, SecurityLaneId, SecurityRuleRow } from "./contract.js";
import type { SecurityInput } from "./classify.js";

export type SecurityRuleHead = Omit<SecurityRuleRow, "opened">;

/** The chosen lane read by rule: its summary line and one row per rule or package. */
export function securityByRule(
  _input: SecurityInput,
  _lane: SecurityLaneId,
): Omit<SecurityByRule, "rules"> & { rules: SecurityRuleHead[] } {
  return {
    summary: [],
    columns: { worst: "", rule: "", alerts: "", fix: "" },
    heading: [],
    tickMax: 0,
    barMax: 0,
    rules: [],
  };
}
