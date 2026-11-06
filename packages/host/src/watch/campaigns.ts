// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Campaign } from "@spi-code/contracts";
import type { Model } from "@spi-code/core";
import type { WatchInput } from "./project.js";

export function detectedCampaigns(_model: Model, _input: WatchInput): Campaign[] {
  return [];
}
