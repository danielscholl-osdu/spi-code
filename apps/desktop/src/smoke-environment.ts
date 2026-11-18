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
          url: "https://api.github.com/repos/example/indexer/deployments/8",
        },
      ],
    },
    ...(env.borrows ?? []),
  ];
  return body;
}
