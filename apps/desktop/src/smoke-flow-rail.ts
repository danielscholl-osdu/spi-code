// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

export interface RailBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface RailLane {
  cells: RailBox[];
  arrows: RailBox[];
}

/** Today's flow at the narrowest centre, measured in the page: every visible arrow glyph and line. */
export interface RailProbe {
  flow: RailBox;
  sideways: { flow: number; centre: number };
  stations: RailLane;
  doors: RailLane;
  rail: RailBox | null;
  turn: RailBox | null;
  main: RailBox;
  environment: RailBox;
  right: RailBox[];
  down: RailBox[];
}

const SLACK = 1.5;
const middle = (box: RailBox) => (box.top + box.bottom) / 2;
const centre = (box: RailBox) => (box.left + box.right) / 2;
const overlaps = (a: RailBox, b: RailBox) =>
  a.left < b.right - SLACK &&
  b.left < a.right - SLACK &&
  a.top < b.bottom - SLACK &&
  b.top < a.bottom - SLACK;
const round = (box: RailBox) =>
  `${Math.round(box.left)},${Math.round(box.top)}-${Math.round(box.right)},${Math.round(box.bottom)}`;

/** What the restacked flow draws wrong; empty when it lands on Main by one rail. */
export function railFaults(probe: RailProbe): string[] {
  const faults: string[] = [];
  const { rail, turn, main, environment } = probe;
  if (probe.sideways.flow > 0) faults.push(`the flow scrolls ${probe.sideways.flow}px sideways`);
  if (probe.sideways.centre > 0)
    faults.push(`the centre scrolls ${probe.sideways.centre}px sideways`);
  if (!rail) faults.push("no rail is drawn");
  else {
    const cellsRight = Math.max(
      ...[...probe.stations.cells, ...probe.doors.cells].map((b) => b.right),
    );
    if (rail.left < cellsRight || probe.flow.right - rail.right > 16)
      faults.push(`the rail at ${round(rail)} is not down the right edge of ${round(probe.flow)}`);
  }
  for (const [name, lane] of [
    ["stations", probe.stations],
    ["doors", probe.doors],
  ] as const) {
    const end = Math.max(...lane.cells.map((box) => box.right));
    const ends = lane.arrows.filter((arrow) => arrow.left >= end - SLACK);
    if (ends.length !== 1) {
      faults.push(`the ${name} lane ends in ${ends.length} → at its right end`);
      continue;
    }
    const [arrow] = ends as [RailBox];
    if (rail && (arrow.right < rail.left - 4 || arrow.right > rail.right + SLACK))
      faults.push(`the ${name} lane's → at ${round(arrow)} does not reach the rail`);
    if (rail && (middle(arrow) < rail.top || middle(arrow) > rail.bottom))
      faults.push(`the ${name} lane's → at ${round(arrow)} is beside no rail`);
  }
  if (!turn) faults.push("the rail does not turn along the bottom");
  else if (rail && (Math.abs(turn.right - rail.right) > 2 || turn.top > rail.bottom + 2))
    faults.push(`the turn at ${round(turn)} does not meet the rail at ${round(rail)}`);
  if (probe.down.length !== 1) faults.push(`${probe.down.length} ↓ in the flow, not one`);
  for (const drop of probe.down) {
    const doorsBottom = Math.max(...probe.doors.cells.map((box) => box.bottom));
    if (centre(drop) < main.left || centre(drop) > main.right || drop.bottom > main.top + 6)
      faults.push(`the ↓ at ${round(drop)} does not land on Main at ${round(main)}`);
    if (drop.top < doorsBottom - SLACK)
      faults.push(
        `the ↓ at ${round(drop)} starts above the doors' bottom ${Math.round(doorsBottom)}`,
      );
    if (turn && (drop.top > turn.bottom || drop.right < turn.left))
      faults.push(`the ↓ at ${round(drop)} is not fed by the turn at ${round(turn)}`);
  }
  const between = probe.right.filter(
    (arrow) =>
      arrow.left >= main.right - SLACK &&
      arrow.right <= environment.left + SLACK &&
      middle(arrow) > main.top &&
      middle(arrow) < main.bottom,
  );
  if (between.length !== 1) faults.push(`${between.length} → from Main to Environment, not one`);
  for (const arrow of [...probe.right, ...probe.down])
    for (const door of probe.doors.cells)
      if (overlaps(arrow, door))
        faults.push(`an arrow at ${round(arrow)} lies under the door at ${round(door)}`);
  return faults;
}

/** Runs in the page: measures the flow for railFaults. */
export const railProbeScript = `(() => {
  const box = (element) => { const { left, top, right, bottom } = element.getBoundingClientRect(); return { left, top, right, bottom }; };
  const shown = (element) => element && element.getClientRects().length > 0 && element.getBoundingClientRect().width > 0;
  const flow = document.querySelector(".today .fleet-flow");
  const glyphs = (root, glyph) => [...root.querySelectorAll("*")]
    .filter(element => element.children.length === 0 && element.textContent.trim() === glyph && shown(element))
    .map(box);
  const lane = (selector) => {
    const root = flow.querySelector(selector);
    return { cells: [...root.querySelectorAll(".fleet-cell")].map(box), arrows: glyphs(root, "→") };
  };
  const line = (selector) => { const element = flow.querySelector(selector); return shown(element) ? box(element) : null; };
  const [main, environment] = [...flow.querySelectorAll(":scope > .fleet-slot > .fleet-cell")].map(box);
  const scroller = document.querySelector(".today-frame").closest(".centre-body > *");
  return {
    flow: box(flow),
    sideways: { flow: flow.scrollWidth - flow.clientWidth, centre: scroller.scrollWidth - scroller.clientWidth },
    stations: lane(".fleet-lane--stations"),
    doors: lane(".fleet-lane--doors"),
    rail: line(".fleet-rail"),
    turn: line(".fleet-turn"),
    main,
    environment,
    right: glyphs(flow, "→"),
    down: glyphs(flow, "↓"),
  };
})()`;
