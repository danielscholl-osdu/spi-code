// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type AmbientLine, type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";

export const ROLLOUT: AmbientLine = {
  id: "ambient:rollout",
  itemIds: ["rollout"],
  count: 1,
  age: "1d 2h",
  next: ["indexer", "crs-catalog"],
  origin: "system",
  text: "Template rollout: merge indexer and crs-catalog.",
};
export const SYNC_PR: AmbientLine = {
  id: "ambient:gate1:workflow",
  itemIds: ["gate1:workflow"],
  count: 1,
  service: "workflow",
  station: "sync",
  pr: {
    number: 59,
    url: "https://github.com/Azure/osdu-spi-workflow/pull/59",
    inspect: "gate1:workflow",
  },
  state: { text: "review", tone: "warn" },
  age: "13h",
  origin: "upstream",
  text: "workflow sync PR #59 waits for review.",
};
export const CASCADE: AmbientLine = {
  id: "ambient:gate2:search",
  itemIds: ["gate2:search"],
  count: 1,
  service: "search",
  station: "cascade",
  pr: {
    number: 76,
    url: "https://github.com/Azure/osdu-spi-search/pull/76",
    inspect: "gate2:search",
  },
  state: { text: "approval", tone: "warn" },
  followUp: "⟲ after drain",
  age: "12h",
  origin: "system",
  text: "search release/upstream PR #76 waits for approval.",
};

/** A morning given an In progress run and a Can wait list, as core would send them. */
export function moving(
  body: ViewSnapshot,
  lines: AmbientLine[] = [ROLLOUT, SYNC_PR, CASCADE],
): ViewSnapshot {
  const ambient = body.briefing.ambient;
  if (!ambient) throw new Error("the morning carries no Ambient split");
  ambient.inProgress = {
    items: lines.reduce((sum, line) => sum + line.count, 0),
    text: `${lines.length} in ${lines.length}`,
    lines,
  };
  body.briefing.canWait = {
    chips: [
      { text: "232 upstream-owned", count: 232 },
      { text: "file", service: "file" },
    ],
    items: [
      {
        id: "background:security",
        itemIds: ["background:security"],
        text: "232 upstream-owned",
        why: "No action is due today. A later Sync Upstream fixes them.",
      },
      {
        id: "can-wait:file",
        itemIds: [],
        service: "file",
        text: "file: no sync, gate or release waiting",
        why: "no sync, gate or release waiting",
      },
    ],
  };
  return ViewSnapshotSchema.parse(body);
}
