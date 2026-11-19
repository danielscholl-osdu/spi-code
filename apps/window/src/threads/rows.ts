// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { TimelineEntry, ToolCall } from "./types.js";

export interface WorkGroupRow {
  kind: "work";
  id: string;
  calls: readonly ToolCall[];
}

export type TimelineRow = Exclude<TimelineEntry, ToolCall> | WorkGroupRow;

/** Consecutive calls become one work group, as T3 Code's work log groups them. */
export function timelineRows(entries: readonly TimelineEntry[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let group: ToolCall[] | null = null;
  for (const entry of entries) {
    if (entry.kind === "call") {
      if (group) group.push(entry);
      else {
        group = [entry];
        rows.push({ kind: "work", id: `work:${entry.id}`, calls: group });
      }
      continue;
    }
    group = null;
    rows.push(entry);
  }
  return rows;
}

export function workSummary(calls: readonly ToolCall[]): string {
  const count = (status: ToolCall["status"]) => calls.filter((c) => c.status === status).length;
  const parts = [calls.length === 1 ? "1 call" : `${calls.length} calls`];
  const failed = count("failed");
  const running = count("running");
  const unknown = count("unknown");
  if (failed) parts.push(`${failed} failed`);
  if (running) parts.push(`${running} running`);
  if (unknown) parts.push(`${unknown} not known`);
  return parts.join(" · ");
}
