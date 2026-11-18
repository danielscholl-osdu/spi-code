// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";

export const ENVIRONMENT_LIVE = '.environment .env-status[data-state="in-use"] button';
export const ENVIRONMENT_BORROW = '.environment .popover[data-selection^="borrow~"]';
export const ENVIRONMENT_LINK = `${ENVIRONMENT_BORROW} [data-kind="deploy"]`;

export function smokeEnvironment(source: ViewSnapshot): ViewSnapshot {
  const body = structuredClone(source);
  const env = body.briefing.environment;
  const id = "indexer:smoke";
  const start = new Date(Date.parse(env.to) - 81 * 60_000).toISOString();
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
    ...(env.borrows ?? []),
  ];
  stackLanes(env);
  return body;
}

export const ENVIRONMENT_STACK = '.environment [data-lane="reset"] .env-last';

/** Reset, read 15 days back, and a by-hand smoke after a missed nightly, over the recorded lanes. */
function stackLanes(env: ViewSnapshot["briefing"]["environment"]) {
  const to = Date.parse(env.to);
  const at = (hours: number) => new Date(to - hours * 3_600_000).toISOString();
  const refresh = env.lanes.findIndex(({ id }) => id === "refresh");
  env.lanes.splice(refresh + 1, 0, {
    id: "reset",
    label: "Reset",
    events: [],
    cadence: "by hand, weekly",
    last: { text: "Tue 3 Nov \u00b7 green", note: "15 days ago", late: true },
  });
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
