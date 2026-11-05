// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import Environment from "../views/environment/index.js";
import Flow from "../views/flow/index.js";
import Horizon from "../views/horizon/index.js";
import Releases from "../views/releases/index.js";
import Repositories from "../views/repositories/index.js";
import Setup from "../views/setup/index.js";
import Today from "../views/today/index.js";

export const routes = [
  { id: "today", label: "Today", View: Today },
  { id: "repositories", label: "Repositories", View: Repositories },
  { id: "releases", label: "Releases", View: Releases },
  { id: "environment", label: "Environment", View: Environment },
  { id: "flow", label: "Flow", View: Flow },
  { id: "horizon", label: "Horizon", View: Horizon },
  { id: "setup", label: "Setup", View: Setup },
] as const;
