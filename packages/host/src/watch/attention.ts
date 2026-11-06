// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { FocusItem, ItemAttention, WatchItem } from "@spi-code/contracts";
import type { Model } from "@spi-code/core";
import type { WatchInput } from "./project.js";

export interface AttentionInput {
  readonly leadTimeMs: number;
  readonly previous: readonly WatchItem[];
}

export function itemAttention(
  _item: FocusItem,
  _model: Model,
  _input: WatchInput,
  _attention: AttentionInput = { leadTimeMs: 2 * 60 * 60 * 1000, previous: [] },
): ItemAttention {
  return { attention: "ambient", owned: false };
}
