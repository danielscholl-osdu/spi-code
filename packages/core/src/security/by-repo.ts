// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SecurityByRepository, SecurityLaneId } from "./contract.js";
import type { SecurityInput } from "./classify.js";

/** The chosen lane read by repository: a row per repository with alerts, and the ones with nothing. */
export function securityByRepository(_input: SecurityInput, _lane: SecurityLaneId): SecurityByRepository {
  return { barMax: 0, rows: [], clean: [] };
}
