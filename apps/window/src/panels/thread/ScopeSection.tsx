// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ThreadSection } from "./section.js";
import { PROGRAM, type ThreadTabProps } from "./tab.js";

function Scope({ summary }: ThreadTabProps) {
  const scope = summary?.thread.scope;
  if (!scope) return <span data-quiet="not-known">⌀ Not known</span>;
  return <span>{scope === PROGRAM ? "Program · every repository" : scope}</span>;
}

export const SCOPE_SECTION: ThreadSection = { id: "scope", label: "Scope", Field: Scope };
