// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  buildModel,
  builtInFleet,
  createContext,
  fleetOf,
  forkActions,
  parseRollout,
  planActions,
  reasonSources,
} from "@spi-code/core";
import { expect, test } from "vitest";
import type { Facts } from "../../src/facts.js";
import { heldFacts, UPSTREAM_NOW, UPSTREAM_SERVICES, waveFacts } from "../upstream-states.js";

function modelOf(f: Facts) {
  return buildModel(
    f,
    UPSTREAM_NOW,
    {},
    createContext({
      fleet: fleetOf(builtInFleet(UPSTREAM_SERVICES)),
      rollout: parseRollout(f.fleet.data?.rollout as string).rollout,
    }),
  );
}

test("the public entry reads the reason sources its own actions carry", () => {
  const m = modelOf(heldFacts());
  const storage = m.upstream.forks.find((x) => x.service === "storage");
  if (!storage) throw new Error("fixture has storage");
  const o = { swept: m.sweptAt ?? "", load: m.lanes, now: UPSTREAM_NOW };
  expect(reasonSources(forkActions(m.upstream, storage, o).primary)).toEqual(["lifecycle"]);
  const w = modelOf(waveFacts());
  const blocked = planActions(w.upstream, {
    swept: w.sweptAt ?? "",
    load: w.lanes,
    now: UPSTREAM_NOW,
    blocked: "no repo scope",
  });
  const off = [blocked.primary, ...blocked.secondary].find((a) => a.reason === "no repo scope");
  expect(off && reasonSources(off)).toEqual([]);
});
