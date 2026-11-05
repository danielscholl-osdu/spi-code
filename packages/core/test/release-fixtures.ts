// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Notes } from "../src/notes";

export function skeleton(): Notes {
  return {
    status: "draft",
    headline: "",
    keyChanges: [],
    actions: [],
    highlights: [],
    knownIssues: [],
  };
}
