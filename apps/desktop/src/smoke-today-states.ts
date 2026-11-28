// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { join } from "node:path";
import type { ViewSnapshot } from "@spi-code/contracts";
import {
  captureTodayFrame,
  PENDING_URL,
  pendingThread,
  showToday,
  type TodayCaptureContext,
} from "./smoke-today.js";

type State = {
  id: string;
  hash: string;
  morning: (calm: ViewSnapshot, busy: ViewSnapshot) => ViewSnapshot;
  threads?: (snapshot: ViewSnapshot) => unknown[];
  /** A script the capture waits on, true once the state draws. */
  drawn: string;
  /** What the capture does to the drawn state, and checks, before it is taken. */
  act?: (context: TodayCaptureContext, snapshot: ViewSnapshot) => Promise<void>;
};

/** Quiet: Blocked and Waiting on you both empty, one line in their place. */
function quiet(calm: ViewSnapshot) {
  const snapshot = structuredClone(calm);
  snapshot.briefing.lines = [];
  snapshot.provenance = snapshot.provenance.filter(
    ({ path }) => !path.startsWith("/briefing/lines/"),
  );
  return snapshot;
}

/** Main red on two forks, the rest green. */
function mainRed(_calm: ViewSnapshot, busy: ViewSnapshot) {
  const snapshot = structuredClone(busy);
  const main = snapshot.briefing.today?.fleet?.stations.find(({ id }) => id === "main");
  assert(main && main.forks.length > 2, "Main red needs the busy morning's Main figure");
  main.stopped = main.forks.slice(0, 2);
  main.count = main.forks.length - 2;
  main.forks = main.forks.slice(2);
  return snapshot;
}

/** Busy with a Now row in Moving without you carrying its link, a gap and its age. */
function nowRow(_calm: ViewSnapshot, busy: ViewSnapshot) {
  const snapshot = structuredClone(busy);
  const today = snapshot.briefing.today;
  assert(today, "The busy morning carries Today");
  today.moving.unshift({
    id: "smoke-now",
    label: "search",
    place: "line",
    time: "Now",
    count: 1,
    names: ["search"],
    what: "Integration PR checks rerunning",
    fork: "search",
    link: {
      label: "Integration checks run",
      url: "https://github.com/fixture/search/actions/runs/7",
      kind: "run",
    },
    age: "25m",
    notRead: ["search"],
  });
  return snapshot;
}

/** The first Blocked or Waiting on you group that is not the rollout. */
function plainGroup(snapshot: ViewSnapshot) {
  const line = snapshot.briefing.lines?.find(
    ({ section, members, rollout }) =>
      (section === "blocked" || section === "waiting") && members.length > 1 && !rollout,
  );
  assert(line, "An opened group needs a non-rollout line with more than one member");
  return line;
}

/** Opens the group in place and checks it draws one subrow per member, in core's order. */
async function openGroup(context: TodayCaptureContext, snapshot: ViewSnapshot) {
  const { window, rendered } = context;
  const line = plainGroup(snapshot);
  const group = `document.querySelector('.today tbody[data-line="${line.id}"]')`;
  await window.webContents.executeJavaScript(
    `${group}.querySelector("tr.today-row:not(.today-row--sub) .today-row-head").click()`,
  );
  await rendered(
    `${group}?.matches("[data-expanded]") && ${group}.querySelector("tr.today-row--sub")`,
  );
  const subrows: { id: string; fork: string }[] = await window.webContents.executeJavaScript(
    `[...${group}.querySelectorAll("tr.today-row--sub")].map(row => ({
      id: row.dataset.itemId ?? "",
      fork: row.querySelector(".today-row-fork")?.textContent.trim() ?? "",
    }))`,
  );
  assert.deepEqual(
    subrows,
    line.members.map(({ id, fork }) => ({ id, fork })),
    `Opened group ${line.id} draws one subrow per member`,
  );
}

/** Busy with its Blocked line due before the next upstream sync. */
function blockedDue(_calm: ViewSnapshot, busy: ViewSnapshot) {
  const snapshot = structuredClone(busy);
  const blocked = snapshot.briefing.lines?.find(({ section }) => section === "blocked");
  const due = snapshot.briefing.lines?.find(({ deadline }) => deadline)?.deadline;
  assert(blocked && due, "A Blocked deadline needs a Blocked line and a deadline to borrow");
  blocked.deadline = due;
  return snapshot;
}

const BLOCKED_DUE = `document.querySelector('.today [data-section=blocked] .today-row-due[data-tone="error"]')`;

/** Tabs to the red chip from its row's headline and checks its reason shows on focus. */
async function focusDue(context: TodayCaptureContext) {
  const { window, rendered } = context;
  // A hidden window's page is unfocused, and :focus-visible matches only in a focused page.
  window.webContents.focus();
  await window.webContents.executeJavaScript(
    `${BLOCKED_DUE}.closest("tr").querySelector(".today-row-head").focus()`,
  );
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
  await rendered(
    `document.activeElement === ${BLOCKED_DUE} && ${BLOCKED_DUE}.matches(":focus-visible")`,
  );
  const [tip, shown]: [string, string] = await window.webContents.executeJavaScript(
    `[${BLOCKED_DUE}.dataset.tip, getComputedStyle(${BLOCKED_DUE}, "::after").content]`,
  );
  assert.match(tip, /\p{L}/u, "The Blocked deadline chip carries its reason");
  assert.equal(shown, JSON.stringify(tip), "The Blocked deadline chip shows its reason on focus");
}

const STATES: readonly State[] = [
  {
    id: "today-quiet",
    hash: "#today",
    morning: quiet,
    drawn:
      'document.querySelector(".today .today-table-calm")?.textContent === "Nothing is yours to move."',
  },
  {
    id: "today-main-red",
    hash: "#today",
    morning: mainRed,
    drawn:
      'document.querySelector(".today .fleet-cell[data-station=main] .fleet-value--bad")?.textContent.trim() === "2 red"',
  },
  {
    id: "today-integration-filter",
    hash: "#today/yours/integration",
    morning: (_calm, busy) => busy,
    drawn:
      'document.querySelector(".today .fleet-cell[data-station=integration][aria-pressed=true]") && /^Integration · /.test(document.querySelector(".today .today-filter-scope")?.textContent ?? "")',
  },
  {
    id: "today-pending-now",
    hash: "#today",
    morning: nowRow,
    threads: pendingThread,
    drawn: `(() => {
      const row = document.querySelector('.today [data-section=moving] tr[data-row="smoke-now"]');
      return document.querySelector('.today tr.today-row[data-state=pending][data-request="${PENDING_URL}"]') &&
        row?.querySelector(".today-row-when")?.textContent === "Now" &&
        row.querySelector(".today-row-open a") && row.querySelector(".today-row-gaps") &&
        row.querySelector(".today-row-age-text")?.textContent === "25m";
    })()`,
  },
  {
    id: "today-group-open",
    hash: "#today",
    morning: (_calm, busy) => busy,
    drawn: 'document.querySelector(".today [data-section=waiting] tbody[data-line]")',
    act: openGroup,
  },
  {
    id: "today-blocked-due",
    hash: "#today",
    morning: blockedDue,
    drawn: BLOCKED_DUE,
    act: focusDue,
  },
];

/** Today's header and flow states the mornings don't show, each at 1440 in light. */
export async function captureTodayStates(
  context: TodayCaptureContext,
  calm: ViewSnapshot,
  busy: ViewSnapshot,
): Promise<string[]> {
  const { window, output, rendered, fixture } = context;
  const files: string[] = [];
  window.setContentSize(1440, 800);
  for (const state of STATES) {
    const snapshot = state.morning(calm, busy);
    await showToday(context, snapshot, state.hash, "light", 1440);
    if (state.threads) fixture("threads.result", { threads: state.threads(snapshot) });
    await rendered(state.drawn);
    await state.act?.(context, snapshot);
    const file = `${state.id}-1440-light.png`;
    await captureTodayFrame(context, join(output, file));
    console.log(`Packaged Today ${state.id}/1440/light`);
    files.push(file);
  }
  if (STATES.some(({ threads }) => threads)) fixture("threads.result", { threads: [] });
  return files;
}
