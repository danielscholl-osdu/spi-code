// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { activeThreadCount, ScopeThreads } from "../../threads/ScopeThreads.js";
import type { ServiceTab, TabProps } from "./tabs.js";

function ThreadsPanel({ id }: TabProps) {
  return <ScopeThreads scope={id} />;
}

/** The service's threads; its count is those Waiting on you or Working. */
export const THREADS_TAB: ServiceTab = {
  id: "threads",
  label: "Threads",
  count: ({ id, threads }) => activeThreadCount(threads, id),
  Panel: ThreadsPanel,
};
