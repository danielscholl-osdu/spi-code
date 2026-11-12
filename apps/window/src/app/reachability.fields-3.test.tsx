// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { dealt, sweepFields } from "./reachability-shell.test-helper.js";

sweepFields(dealt(2, 3), (path) => readFileSync(path, "utf8"));
