// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFixture } from "../../../../scripts/watch-generated.mjs";
import { dealt, sweepFields } from "./reachability-shell.test-helper.js";

sweepFields(dealt(0, 3), readFixture);
