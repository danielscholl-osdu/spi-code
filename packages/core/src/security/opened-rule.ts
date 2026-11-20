// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SecurityOpenedRule } from "./contract.js";
import type { SecurityInput } from "./classify.js";
import type { SecurityRuleHead } from "./by-rule.js";

/** An opened rule or package: its facts, where it sits by repository and file, and its pills. */
export function securityOpenedRule(_input: SecurityInput, _rule: SecurityRuleHead): SecurityOpenedRule {
  return { facts: [], where: [], also: [] };
}
