// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ServiceHome, ViewSnapshot } from "@spi-code/contracts";
import type { ComponentType } from "react";
import { Overview } from "./Overview.js";

export type TabProps = {
  id: string;
  home: ServiceHome;
  snapshot: ViewSnapshot;
  /** The row the route opens on this tab. */
  row: string | undefined;
  /** Changes each time a station or door asks for the row again, so it takes focus again. */
  focus?: number | undefined;
};

export type ServiceTab = {
  id: string;
  label: string;
  /** What is not fine on the tab; null when it was not read. */
  count?: (props: Omit<TabProps, "row" | "focus">) => number | null;
  Panel: ComponentType<TabProps>;
};

/** A service page's tabs, in order; the first opens when the route names none. */
export const TABS: readonly ServiceTab[] = [{ id: "overview", label: "Overview", Panel: Overview }];
