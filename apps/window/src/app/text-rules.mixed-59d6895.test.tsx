// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { textRulesOn } from "./text-rules.test-helper.js";

textRulesOn("snapshot-mixed-59d6895.json", (path) => readFileSync(path, "utf8"));
