// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ThreadSection } from "./section.js";
import type { ThreadTabProps } from "./tab.js";

function Worktree({ summary }: ThreadTabProps) {
  const landsIn = summary?.thread.landsIn;
  if (!landsIn || landsIn.target === "asking")
    return <span data-quiet="none">None. An Asking thread reads the shared clone.</span>;
  return <code className="thread-field-path">{landsIn.worktree}</code>;
}

export const WORKTREE_SECTION: ThreadSection = {
  id: "worktree",
  label: "Worktree",
  Field: Worktree,
};
