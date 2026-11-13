// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFixture } from "../../../../scripts/watch-generated.mjs";
import { textRulesOn } from "./text-rules.test-helper.js";

textRulesOn("snapshot-1106-unread.json", readFixture);
