// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SecurityPage } from "@spi-code/contracts";
import type { SecurityInput } from "./classify.js";

/** The line above the headline, the headline, the not-read banner and the lane the page opens on. */
export function securityPage(_input: SecurityInput): SecurityPage {
  return { totals: [], headline: [], banner: [], opens: "spi" };
}
