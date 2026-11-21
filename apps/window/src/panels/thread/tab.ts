// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ComponentType } from "react";
import type { ThreadSummary } from "../../threads/store.js";

export type ThreadTabProps = {
  id: string;
  /** Undefined while the host has not listed the thread, or does not know it. */
  summary: ThreadSummary | undefined;
};

export type ThreadTab = {
  id: string;
  label: string;
  Panel: ComponentType<ThreadTabProps>;
  Label?: ComponentType<ThreadTabProps>;
};

export const PROGRAM = "program";
