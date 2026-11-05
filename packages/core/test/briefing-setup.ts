// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { afterAll } from "vitest";
import { builtInFleet, SERVICES, setFleet } from "../src/config";
import "./utc";

const previous = [...SERVICES];
setFleet(builtInFleet(new URL("./fixtures/rib-59d6895/services.json", import.meta.url).pathname));

afterAll(() => setFleet(previous));
