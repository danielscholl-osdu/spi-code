// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";

export const SMOKE_TIME_ZONE = "America/Chicago";

export const ENVIRONMENT_LIVE = '.environment .env-status[data-state="in-use"] button';
export const ENVIRONMENT_BORROW = '.environment .popover[data-selection^="borrow~"]';
export const ENVIRONMENT_LINK = `${ENVIRONMENT_BORROW} [data-kind="deploy"]`;
export const ENVIRONMENT_ACTIVITY = ".environment .env-activity";
export const ENVIRONMENT_OVERLAP = `${ENVIRONMENT_ACTIVITY} button[data-mark="overlap"]`;
export const ENVIRONMENT_HOLD = `${ENVIRONMENT_ACTIVITY} button[data-mark="maintenance"]`;
export const ENVIRONMENT_WEEK = ".environment .env-range button:last-child";
export const ENVIRONMENT_YESTERDAY =
  '[...document.querySelectorAll(".environment .env-day-heading")].at(-2)';
export const ENVIRONMENT_BACK = ".environment .env-back";
/** Every day heading and fork pill ends at or before the now line. */
export const ENVIRONMENT_INSIDE_NOW = `(() => {
  const now = document.querySelector(".environment .env-now")?.getBoundingClientRect().right;
  const marks = [...document.querySelectorAll(".environment :is(.env-day-heading, .env-pill)")];
  return now !== undefined && marks.length > 0 &&
    marks.every((mark) => mark.getBoundingClientRect().right <= now + 0.5);
})()`;

const UPGRADE_LAST = '.environment [data-lane="upgrade"] .env-last';

/** The opened day before today reads Upgrade's last run as core sent it for that day. */
export function environmentYesterdayUpgrade(source: ViewSnapshot): string {
  const env = source.briefing.environment;
  const day = env.days?.at(-2)?.from;
  const last = env.lanes
    .find(({ id }) => id === "upgrade")
    ?.lasts?.find(({ from }) => from === day)?.text;
  if (!last) throw new Error("The Environment smoke scene needs an Upgrade run before yesterday");
  return `(() => {
  const text = document.querySelector(${JSON.stringify(UPGRADE_LAST)})?.textContent;
  return text === ${JSON.stringify(`\u2039 ${last}`)} || text;
})()`;
}

export function recordedChicagoSnapshot(fixturePath: string): ViewSnapshot {
  return ViewSnapshotSchema.parse(
    JSON.parse(
      readFileSync(join(dirname(fixturePath), "generated", "snapshot-1106-chicago.json"), "utf8"),
    ),
  );
}

export function smokeEnvironment(source: ViewSnapshot): ViewSnapshot {
  const body = structuredClone(source);
  const env = body.briefing.environment;
  const id = "indexer:smoke";
  const at = (minutesAgo: number) =>
    new Date(Date.parse(env.to) - minutesAgo * 60_000).toISOString();
  const start = at(81);
  const search = { start: at(105), end: at(45) };
  env.status = {
    state: "in-use",
    label: "In use",
    length: "1\u00a0h 21\u00a0min",
    live: [{ id, fork: "indexer" }],
  };
  env.borrows = [
    {
      id,
      fork: "indexer",
      branch: "release/upstream",
      result: "running",
      detail: `running · ${start} to now · 1\u00a0h 21\u00a0min`,
      homeLabel: "indexer home",
      start,
      links: [
        { kind: "run", label: "Run", url: "https://github.com/example/indexer/actions/runs/7" },
        {
          kind: "deploy",
          label: "Deployment",
          url: "https://github.com/example/indexer/deployments/spi-stack",
        },
      ],
    },
    {
      id: "search:smoke",
      fork: "search",
      ...search,
      result: "green",
      detail: `green · ${search.start} to ${search.end} · 1\u00a0h`,
      homeLabel: "search home",
      links: [],
    },
    ...(env.borrows ?? []),
  ];
  // The recorded range ends in idle time. Put the synthetic borrows into that gap.
  const segments = env.activity?.segments;
  const last = segments?.at(-1);
  if (!segments || last?.kind !== "idle" || Date.parse(last.start) >= Date.parse(search.start))
    throw new Error("The Environment smoke scene needs an idle gap for the live borrows");
  last.end = search.start;
  segments.push(
    { kind: "borrowed", start: search.start, end: start, title: "search" },
    { kind: "overlap", start, end: search.end, title: "indexer × search" },
    { kind: "borrowed", start: search.end, end: env.to, title: "indexer" },
  );
  stackLanes(env);
  return body;
}

export const ENVIRONMENT_STACK = '.environment [data-lane="reset"] .env-last';

/** An overdue Reset, a waiting Upgrade and a by-hand smoke after a missed nightly. */
function stackLanes(env: ViewSnapshot["briefing"]["environment"]) {
  const to = Date.parse(env.to);
  const at = (hours: number) => new Date(to - hours * 3_600_000).toISOString();
  const refresh = env.lanes.findIndex(({ id }) => id === "refresh");
  const text = "Thu 22 Oct \u00b7 green";
  const late = { text, note: "15 days ago", late: true as const };
  const days = (env.days ?? []).map(({ from }, index, all) => ({
    from,
    to: all[index + 1]?.from ?? env.to,
    text,
  }));
  env.lanes.splice(refresh + 1, 0, {
    id: "reset",
    label: "Reset",
    events: [],
    cadence: "by hand, weekly",
    last: late,
    lasts: [
      { from: env.from, to: env.to, ...late },
      ...days.map((day) => (day.to === env.to ? { ...day, ...late } : day)),
    ],
  });
  const upgrade = env.lanes.find(({ id }) => id === "upgrade");
  if (!upgrade?.last) throw new Error("The Environment smoke scene needs an empty Upgrade lane");
  const note = "v0.35.4 not adopted";
  upgrade.last.note = note;
  for (const last of upgrade.lasts ?? []) if (last.to === env.to) last.note = note;
  const smoke = env.lanes.find(({ id }) => id === "smoke");
  if (!smoke) return;
  smoke.missed = [at(20)];
  smoke.events.push({
    id: "smoke-by-hand",
    start: at(3),
    end: at(2.5),
    state: "ok",
    label: "smoke",
    detail: "green in 30 min",
    byHand: true,
  });
}
