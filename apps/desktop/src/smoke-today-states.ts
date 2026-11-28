// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { join } from "node:path";
import type { ViewSnapshot } from "@spi-code/contracts";
import { captureTodayFrame, showToday, type TodayCaptureContext } from "./smoke-today.js";

const PENDING_URL = "https://github.com/fixture/smoke-pending/pull/901";

type State = {
  id: string;
  hash: string;
  morning: (calm: ViewSnapshot, busy: ViewSnapshot) => ViewSnapshot;
  threads?: (snapshot: ViewSnapshot) => unknown[];
  /** A script the capture waits on, true once the state draws. */
  drawn: string;
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

function pendingThread(snapshot: ViewSnapshot) {
  const fork = snapshot.briefing.today?.fleet?.forks.yours[0];
  assert(fork, "A pending request needs a Yours fork");
  return [
    {
      id: "smoke-pending",
      thread: {
        scope: fork,
        title: "Pin the toolchain",
        request: {
          forge: "github",
          repository: `fixture/${fork}`,
          requestNumber: 901,
          url: PENDING_URL,
        },
      },
      status: "Open",
      sequence: 1,
      updatedAt: Date.parse(snapshot.sweptAt) - 600_000,
      settledAt: null,
      done: false,
    },
  ];
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
      return document.querySelector('.today .request-pending[data-request="${PENDING_URL}"]') &&
        row?.querySelector(".today-row-when")?.textContent === "Now" &&
        row.querySelector(".today-row-open a") && row.querySelector(".today-row-gaps") &&
        row.querySelector(".today-row-age-text")?.textContent === "25m";
    })()`,
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
    const file = `${state.id}-1440-light.png`;
    await captureTodayFrame(context, join(output, file));
    console.log(`Packaged Today ${state.id}/1440/light`);
    files.push(file);
  }
  if (STATES.some(({ threads }) => threads)) fixture("threads.result", { threads: [] });
  return files;
}
