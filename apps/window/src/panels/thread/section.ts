// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ComponentType } from "react";
import type { ThreadTabProps } from "./tab.js";

/** One labelled field of the Thread tab; later sections are added beside these files. */
export type ThreadSection = { id: string; label: string; Field: ComponentType<ThreadTabProps> };
