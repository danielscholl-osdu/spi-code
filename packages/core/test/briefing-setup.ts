// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { fileURLToPath } from "node:url";
import { builtInFleet, fleetOf } from "../src/config";
import { createContext } from "../src/context";
import "./utc";

export const fixtureContext = createContext({
  fleet: fleetOf(
    builtInFleet(fileURLToPath(new URL("./fixtures/rib-59d6895/services.json", import.meta.url))),
  ),
});
export const FORKS = fixtureContext.fleet.forks;
