// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFixture } from "../../../../scripts/watch-generated.mjs";
import { dealt, itemHomesOn } from "./reachability-shell.test-helper.js";

itemHomesOn(dealt(0, 3), readFixture);
