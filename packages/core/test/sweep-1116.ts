// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildBriefing } from "../src/brief/index";
import { builtInFleet, fleetOf } from "../src/config";
import { createContext } from "../src/context";
import { emptyFacts, type Facts } from "../src/facts";
import type { DismissEntry } from "../src/model/dismiss";
import { buildModel, type Model } from "../src/model/index";
import { parseRollout } from "../src/rollout";
import "./utc";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/** The live sweep behind design/spi-code-today-and-places.html: Mon 16 Nov 19:06 Chicago. */
export function sweep1116Facts(): Facts {
  return { ...emptyFacts(), ...JSON.parse(readFileSync(fixture("upstream-1116.json"), "utf8")) };
}

export const SWEEP_1116_NOW = new Date("2026-11-17T01:06:12.682Z");

const { rollout } = parseRollout(readFileSync(fixture("rib-59d6895/rollout.json"), "utf8"));
export const sweep1116Context = createContext({
  fleet: fleetOf(builtInFleet(fixture("upstream-services.json"))),
  ...(rollout ? { rollout } : {}),
  clock: { now: () => SWEEP_1116_NOW },
});

export function sweep1116Model(
  facts = sweep1116Facts(),
  dismissed: readonly DismissEntry[] = [],
): Model {
  return buildModel(facts, SWEEP_1116_NOW, { dismissed }, sweep1116Context);
}

export function sweep1116Items(model = sweep1116Model()) {
  const b = buildBriefing(
    model,
    { state: "clear", problems: [] },
    SWEEP_1116_NOW,
    sweep1116Context,
  );
  return [...b.focus, ...b.rest];
}
