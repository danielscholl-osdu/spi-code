// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SecurityPane } from "@spi-code/contracts";
import { type Model, securityPane } from "@spi-code/core";
import type { WatchInput } from "./project.js";

/** The Security place's pane: every open alert by lane, with the lists this sweep did not read. */
export function projectSecurity(model: Model, input: WatchInput, now: Date): SecurityPane {
  return securityPane({
    model,
    facts: input.facts,
    reads: input.reads,
    context: input.context,
    now,
  });
}
