// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { FocusItem, ItemAttention } from "@spi-code/contracts";
import type { Model } from "@spi-code/core";
import type { WatchInput } from "./project.js";

export function itemAttention(_item: FocusItem, _model: Model, _input: WatchInput): ItemAttention {
  return { attention: "ambient", owned: false };
}
