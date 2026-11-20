// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { EVIDENCE_TAB } from "./EvidenceTab.js";
import { READING_TAB } from "./ReadingTab.js";
import type { ThreadTab } from "./tab.js";

/** A thread's right-panel tabs, in order; the first opens with the panel. */
export const THREAD_TABS: readonly ThreadTab[] = [READING_TAB, EVIDENCE_TAB];
