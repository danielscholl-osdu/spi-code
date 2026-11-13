// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { CASCADE_WORKFLOW, SYNC_UPSTREAM_WORKFLOW } from "../config.js";
import type { CoreContext } from "../context.js";
import type { LaneLoad } from "../model/lanes.js";
import type { UpFork, UpstreamModel } from "../model/upstream.js";
import { names, plural, stamp } from "../util.js";
import { type ActionItem, type Target, type Verb, verbAction } from "./verbs.js";

function cascadeArgs(t: Target): string[] {
  return ["workflow", "run", CASCADE_WORKFLOW, "-R", t.repo, "-f", `issue_number=${t.issue ?? ""}`];
}

// Sync Upstream only opens a sync PR into fork_upstream; nothing merges and no lane is taken.
export const PREPARE: Verb = Object.freeze<Verb>({
  id: "sync-upstream",
  label: "Prepare",
  command: (t) => ["workflow", "run", SYNC_UPSTREAM_WORKFLOW, "-R", t.repo],
});

// Sync PRs into fork_upstream land as merge commits; the cascade's ancestry check needs it.
export const START: Verb = Object.freeze<Verb>({
  id: "start-upstream",
  label: "Start",
  command: (t) => ["pr", "merge", String(t.number), "-R", t.repo, "--merge"],
  followUp: cascadeArgs,
  paced: true,
});

export const DISPATCH_CASCADE: Verb = Object.freeze<Verb>({
  id: "dispatch-cascade",
  label: "Dispatch cascade",
  command: cascadeArgs,
  paced: true,
});

export const RERUN_CASCADE: Verb = Object.freeze<Verb>({
  id: "rerun-cascade",
  label: "Re-run cascade",
  command: cascadeArgs,
  paced: true,
});

export function prepareTarget(f: UpFork): Target {
  return {
    repo: f.repo,
    kind: "workflow",
    workflow: SYNC_UPSTREAM_WORKFLOW,
    state: "idle",
    label: f.service,
  };
}

export function startTarget(f: UpFork): Target {
  return {
    repo: f.repo,
    kind: "pr",
    number: f.syncPr?.number,
    sha: f.syncPr?.headSha,
    state: "open",
    ...(f.tracking ? { issue: f.tracking.number } : {}),
    label: `${f.service} #${f.syncPr?.number}`,
  };
}

export function cascadeTarget(f: UpFork): Target {
  return {
    repo: f.repo,
    kind: "workflow",
    workflow: CASCADE_WORKFLOW,
    state: "idle",
    // The newest cascade run as drawn; a run after it means the board's reason is stale.
    ...(f.cascadeRun ? { number: f.cascadeRun.id } : {}),
    ...(f.tracking ? { issue: f.tracking.number } : {}),
    label: f.service,
  };
}

function services(list: readonly UpFork[]): string {
  return names(list.map((f) => f.service));
}

function laneText(u: UpstreamModel): string[] {
  const l = u.lanes;
  if (l.cap === null) return ["Unpaced: rollout.json sets no lane cap."];
  if (l.unread) return [`Lanes unknown until ${l.unread} are read, so nothing starts.`];
  return [
    `Lanes are shared with the template rollout: ${l.busy} of ${l.cap} in flight${l.holders.length ? ` (${names(l.holders)})` : ""}${l.claims ? `, ${plural(l.claims, "cascade")} claiming one` : ""}. A press only tops up to ${l.cap}.`,
  ];
}

function orderText(u: UpstreamModel, forks: readonly UpFork[]): string[] {
  return u.ordering
    .filter((o) => forks.some((f) => f.service === o.service))
    .map(
      (o) =>
        `${o.service} starts only after ${names(o.after)} ${o.after.length === 1 ? "is" : "are"} on main${o.reason ? ` (${o.reason})` : ""}.`,
    );
}

export function prepareAction(
  u: UpstreamModel,
  forks: readonly UpFork[],
  opts: {
    swept: string;
    item: string;
    now: Date;
    label?: string;
    primary?: boolean;
    extra?: string[];
    context?: Pick<CoreContext, "timeStyle">;
  },
): ActionItem {
  const at = stamp(u.schedule.upstream, opts.now, opts.context);
  return verbAction(
    PREPARE,
    { item: opts.item, swept: opts.swept, targets: forks.map(prepareTarget) },
    {
      ...(opts.primary ? { primary: true } : {}),
      label: opts.label ?? `Prepare ${services(forks)}`,
      pending: `Dispatching Sync Upstream on ${forks.length}…`,
      title: `Prepare · dispatch Sync Upstream on ${plural(forks.length, "fork")}`,
      detail: [
        `Dispatches Sync Upstream on ${services(forks)}${at ? ` now instead of at ${at}` : ""}. Each opens a sync PR into fork_upstream with the filtered tree and a tracking issue. Nothing merges, and no lane is taken.`,
        ...(opts.extra ?? []),
        "Each fork is read again first: one with a sync PR already open or Sync Upstream running is skipped.",
      ],
    },
  );
}

export function startAction(
  u: UpstreamModel,
  forks: readonly UpFork[],
  opts: {
    swept: string;
    item: string;
    load: LaneLoad;
    label?: string;
    primary?: boolean;
    extra?: string[];
  },
): ActionItem {
  const n = forks.length;
  return verbAction(
    START,
    { item: opts.item, swept: opts.swept, targets: forks.map(startTarget) },
    {
      ...(opts.primary ? { primary: true } : {}),
      label: opts.label ?? `Start ${services(forks)}`,
      pending: `Starting ${n}…`,
      title: `Start · merge ${plural(n, "sync PR")} and dispatch the cascade`,
      detail: [
        `Merges ${names(forks.map((f) => `${f.service} #${f.syncPr?.number}`))} into fork_upstream with a merge commit, then dispatches Cascade Integration with each tracking issue at once instead of waiting up to 6 hours for the monitor.`,
        "The cascade merges main and upstream into fork_integration and builds core and azure on GitHub runners. A green one opens a Sync to Main PR that borrows a lane, and its push to main borrows another.",
        ...laneText(u),
        ...orderText(u, forks),
        ...(opts.extra ?? []),
      ],
      subject: {
        value: String(n),
        label: `Type ${n}: the number of sync PRs this merges`,
      },
    },
  );
}

export function cascadeAction(
  verb: Verb,
  u: UpstreamModel,
  forks: readonly UpFork[],
  opts: {
    swept: string;
    item: string;
    label?: string;
    primary?: boolean;
    now: Date;
    context?: Pick<CoreContext, "timeStyle">;
  },
): ActionItem {
  const rerun = verb.id === RERUN_CASCADE.id;
  const fixed =
    forks.length === 1 ? stamp(forks[0]?.stop?.run?.updatedAt, opts.now, opts.context) : undefined;
  return verbAction(
    verb,
    { item: opts.item, swept: opts.swept, targets: forks.map(cascadeTarget) },
    {
      ...(opts.primary ? { primary: true } : {}),
      label: opts.label ?? `${verb.label} · ${services(forks)}`,
      pending: rerun ? "Re-running…" : "Dispatching…",
      title: `${verb.label} · ${services(forks)}`,
      detail: [
        rerun
          ? `A fix landed on fork_integration after the failed cascade${fixed ? ` (${fixed})` : ""}, so the cascade runs again with each tracking issue.`
          : `The sync PR merged and no cascade ran, so this dispatches Cascade Integration with each tracking issue.`,
        "A green cascade opens a Sync to Main PR that borrows a lane.",
        ...laneText(u),
        "Each fork is read again first: one with a cascade already running is skipped.",
      ],
    },
  );
}
