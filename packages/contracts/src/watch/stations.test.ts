// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, test } from "vitest";
import { isStoppedFork, type Station } from "./stations.js";

test.each(["upstream", "sync", "cascade", "main", "release", "lane"] as const)(
  "%s stops the fork only when it is a line station",
  (id) => {
    expect(isStoppedFork([{ id, substate: "stopped" }])).toBe(id !== "lane");
  },
);

test.each(["waiting-on-person", "waiting-on-clock", "in-progress", "ready"] as const)(
  "%s does not stop a fork",
  (substate) => {
    const stations: Pick<Station, "id" | "substate">[] = [
      { id: "sync", substate },
      { id: "lane", substate: "stopped" },
    ];
    expect(isStoppedFork(stations)).toBe(false);
  },
);
