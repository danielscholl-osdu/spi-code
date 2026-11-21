// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ServiceHome, ViewSnapshot } from "@spi-code/contracts";
import type { ComponentType } from "react";
import type { ThreadSummary } from "../../threads/store.js";
import { Issues, issueCount, issuesHeld } from "./issues.js";
import { Overview } from "./Overview.js";
import { Pulls, pullCount, pullsHeld } from "./pulls.js";
import { runsTab } from "./runs.js";
import { SECURITY_TAB } from "./security.js";
import { THREADS_TAB } from "./threads.js";
import { UPSTREAM_TAB } from "./upstream.js";

export type TabProps = {
  id: string;
  home: ServiceHome;
  snapshot: ViewSnapshot;
  /** The row the route opens on this tab. */
  row: string | undefined;
  /** Changes each time a station or door asks for the row again, so it takes focus again. */
  focus?: number | undefined;
  /** The host's threads; null until it lists them. */
  threads?: readonly ThreadSummary[] | null;
};

export type ServiceTab = {
  id: string;
  label: string;
  /** What is not fine on the tab; null when it was not read. */
  count?: (props: Omit<TabProps, "row" | "focus">) => number | null;
  /** The count is what an earlier read held, as this sweep's read failed. */
  held?: (props: Omit<TabProps, "row" | "focus">) => boolean;
  Panel: ComponentType<TabProps>;
};

/** A service page's tabs, in order; the first opens when the route names none. */
export const TABS: readonly ServiceTab[] = [
  { id: "overview", label: "Overview", Panel: Overview },
  UPSTREAM_TAB,
  { id: "pulls", label: "Pull requests", Panel: Pulls, count: pullCount, held: pullsHeld },
  { id: "issues", label: "Issues", Panel: Issues, count: issueCount, held: issuesHeld },
  runsTab,
  SECURITY_TAB,
  THREADS_TAB,
];
