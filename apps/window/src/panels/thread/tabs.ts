// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { ChangesCount } from "./ChangesCount.js";
import { CHANGES_TAB } from "./ChangesTab.js";
import { EVIDENCE_TAB } from "./EvidenceTab.js";
import { READING_TAB } from "./ReadingTab.js";
import { THREAD_TAB } from "./ThreadTab.js";
import type { ThreadTab } from "./tab.js";

/** A thread's right-panel tabs, in order; the first opens with the panel. */
export const THREAD_TABS: readonly ThreadTab[] = [
  THREAD_TAB,
  { ...CHANGES_TAB, Label: ChangesCount },
  READING_TAB,
  EVIDENCE_TAB,
];
