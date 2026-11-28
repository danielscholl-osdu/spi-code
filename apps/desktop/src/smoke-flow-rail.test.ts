// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it } from "vitest";
import { painted, type RailBox, type RailProbe, railFaults } from "./smoke-flow-rail.js";

const box = (left: number, top: number, right: number, bottom: number): RailBox => ({
  left,
  top,
  right,
  bottom,
});

const stationsEnd = box(481, 126, 492, 138);
const doorsEnd = box(481, 197, 492, 209);
const sep = box(248, 276, 260, 288);
const drop = box(41, 235, 49, 251);

/** The narrowest-centre board as measured: three stations, four doors, the rail, its turn and ↓. */
const restacked: RailProbe = {
  flow: box(16, 100, 504, 311),
  sideways: { flow: 0, centre: 0 },
  stations: {
    cells: [box(7, 104, 160, 160), box(170, 104, 320, 160), box(330, 104, 479, 160)],
    arrows: [box(162, 126, 172, 138), box(322, 126, 332, 138), stationsEnd],
  },
  doors: {
    cells: [
      box(7, 180, 118, 226),
      box(122, 180, 233, 226),
      box(237, 180, 348, 226),
      box(352, 180, 479, 226),
    ],
    arrows: [doorsEnd],
  },
  rail: box(492.5, 122, 494, 230),
  turn: box(47, 230, 494, 239),
  main: box(17, 254, 245, 310),
  environment: box(263, 254, 503, 310),
  right: [box(162, 126, 172, 138), box(322, 126, 332, 138), stationsEnd, doorsEnd, sep],
  down: [drop],
};

it("passes the flow restacked onto a rail that lands on Main", () => {
  expect(railFaults(restacked)).toEqual([]);
});

it.each<[string, Partial<RailProbe>, string]>([
  [
    "two columns with no rail",
    {
      rail: null,
      turn: null,
      down: [],
      stations: { ...restacked.stations, arrows: restacked.stations.arrows.slice(0, 2) },
      doors: { ...restacked.doors, arrows: [] },
    },
    "no rail is drawn",
  ],
  ["sideways scroll", { sideways: { flow: 12, centre: 0 } }, "the flow scrolls 12px sideways"],
  ["a ↓ per lane", { down: [drop, box(470, 235, 478, 251)] }, "2 ↓ in the flow, not one"],
  [
    "a ↓ beside Main",
    { down: [box(300, 235, 308, 251)] },
    "the ↓ at 300,235-308,251 does not land on Main at 17,254-245,310",
  ],
  [
    "a ↓ under a door",
    { down: [box(41, 214, 49, 251)] },
    "the ↓ at 41,214-49,251 starts above the doors' bottom 226",
  ],
  [
    "a doors lane with no end",
    { doors: { ...restacked.doors, arrows: [] } },
    "the doors lane ends in 0 → at its right end",
  ],
  [
    "a lane end short of the rail",
    { doors: { ...restacked.doors, arrows: [box(481, 197, 485, 209)] } },
    "the doors lane's → at 481,197-485,209 does not reach the rail",
  ],
  [
    "no → from Main",
    { right: restacked.right.slice(0, 4) },
    "0 → from Main to Environment, not one",
  ],
  [
    "an arrow on a door",
    { right: [...restacked.right, box(200, 197, 210, 209)] },
    "an arrow at 200,197-210,209 lies under the door at 122,180-233,226",
  ],
  [
    "a turn apart from the rail",
    { turn: box(47, 230, 470, 239) },
    "the turn at 47,230-470,239 does not meet the rail at 493,122-494,230",
  ],
  [
    "a rail running on past the turn",
    { rail: box(492.5, 122, 494, 258) },
    "the turn at 47,230-494,239 does not meet the rail at 493,122-494,258",
  ],
  [
    "a ↓ that stops short of Main",
    { down: [box(41, 228, 49, 236)] },
    "the ↓ at 41,228-49,236 does not land on Main at 17,254-245,310",
  ],
  [
    "Environment below the → from Main",
    { environment: box(263, 314, 503, 370) },
    "the → at 248,276-260,288 is not level with Main at 17,254-245,310 and Environment at 263,314-503,370",
  ],
])("faults %s", (_, change, fault) => {
  expect(railFaults({ ...restacked, ...change })).toContain(fault);
});

const element = (
  styles: { visibility?: string; opacity?: string },
  parentElement: Parameters<typeof painted>[0] = null,
): NonNullable<Parameters<typeof painted>[0]> => {
  const self: NonNullable<Parameters<typeof painted>[0]> = {
    getClientRects: () => ({ length: 1 }),
    getBoundingClientRect: () => ({ width: 10 }),
    parentElement,
    ownerDocument: {
      defaultView: {
        getComputedStyle: (node) =>
          node === self
            ? { visibility: styles.visibility ?? "visible", opacity: styles.opacity ?? "1" }
            : (node.ownerDocument.defaultView?.getComputedStyle(node) ?? {
                visibility: "visible",
                opacity: "1",
              }),
      },
    },
  };
  return self;
};

it.each<[string, Parameters<typeof painted>[0], boolean]>([
  ["a drawn arrow", element({}), true],
  ["an arrow hidden by visibility", element({ visibility: "hidden" }), false],
  ["an arrow inside a transparent lane", element({}, element({ opacity: "0" })), false],
])("judges whether %s is painted", (_, arrow, drawn) => {
  expect(painted(arrow)).toBe(drawn);
});
