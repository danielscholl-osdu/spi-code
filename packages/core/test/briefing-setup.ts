// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { builtInFleet, fleetOf } from "../src/config";
import { createContext } from "../src/context";
import "./utc";

export const fixtureContext = createContext({
  fleet: fleetOf(
    builtInFleet(new URL("./fixtures/rib-59d6895/services.json", import.meta.url).pathname),
  ),
});
export const FORKS = fixtureContext.fleet.forks;
