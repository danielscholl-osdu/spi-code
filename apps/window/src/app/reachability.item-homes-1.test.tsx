// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { dealt, itemHomesOn } from "./reachability-shell.test-helper.js";

itemHomesOn(dealt(0, 3), (path) => readFileSync(path, "utf8"));
