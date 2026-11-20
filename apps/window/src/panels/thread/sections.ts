// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { COMMIT_SECTION } from "./CommitSection.js";
import { LANDS_IN_SECTION } from "./LandsInSection.js";
import type { ThreadSection } from "./section.js";
import { WORKTREE_SECTION } from "./WorktreeSection.js";

/** The Thread tab's fields, in order. */
export const THREAD_SECTIONS: readonly ThreadSection[] = [
  LANDS_IN_SECTION,
  COMMIT_SECTION,
  WORKTREE_SECTION,
];
