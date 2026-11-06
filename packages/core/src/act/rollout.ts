// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ForkDef, forkOf, SYNC_TEMPLATE_WORKFLOW } from "../config.js";
import type { AreaName } from "../facts.js";
import { type LaneLoad, laneRoom } from "../model/lanes.js";
import { heldBecause, type TemplateModel, type TemplateRow } from "../model/template.js";

export { heldBecause };

import { plural, stamp } from "../util.js";
import { loadSources, sourced } from "./reason-sources.js";
import { type ActionItem, type Target, type Verb, verbAction } from "./verbs.js";

export const ROLLOUT_ITEM = "engineering";

export const SYNC_FORKS: Verb = Object.freeze<Verb>({
  id: "sync-template",
  label: "Sync all forks",
  command: (t) => ["workflow", "run", SYNC_TEMPLATE_WORKFLOW, "-R", t.repo],
  paced: true,
});

// Template-sync PRs have always landed as merge commits, so the rollout keeps that.
export const ROLL_OUT: Verb = Object.freeze<Verb>({
  id: "roll-out",
  label: "Roll out",
  command: (t) => ["pr", "merge", String(t.number), "-R", t.repo, "--merge"],
  paced: true,
});

function names(list: readonly string[]): string {
  return list.length <= 1
    ? (list[0] ?? "")
    : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

// Why a fork never takes a fleet button: a mirror (ADR-039) never runs Sync Template.
function mirrored(repo: string, forks: readonly ForkDef[]): string | undefined {
  const mirror = forkOf(repo, forks)?.mirror;
  return mirror ? "mirror" : mirror === null ? "sync mode unread" : undefined;
}

export interface Paced {
  targets: Target[];
  // Eligible forks past the lane cap, in board order, for the next press.
  waiting: Target[];
}

// The first forks in board order up to the room the cap leaves; the rest wait.
export function paced(eligible: readonly Target[], load: LaneLoad | undefined): Paced {
  const room = load ? laneRoom(load) : Number.POSITIVE_INFINITY;
  const repos = new Set<string>();
  const targets: Target[] = [];
  const waiting: Target[] = [];
  for (const t of eligible) {
    if (repos.has(t.repo) || repos.size < room) {
      repos.add(t.repo);
      targets.push(t);
    } else waiting.push(t);
  }
  return { targets, waiting };
}

function inflight(load: LaneLoad | undefined, repo: string): string | undefined {
  return load?.inflight.find((l) => l.repo === repo)?.what;
}

// Rows come from the template compares and the template-sync PRs.
const ROW_SOURCES: readonly AreaName[] = Object.freeze(["github", "template"]);
const BUSY_SOURCES: readonly AreaName[] = Object.freeze(["github", "runs"]);

// A fork to dispatch: behind main, no Sync Template running, and no PR already at main.
export function syncTargets(
  t: TemplateModel,
  forks: readonly ForkDef[],
  load?: LaneLoad,
): Paced & { skipped: string[] } {
  const { skippedFrom: _, ...plan } = syncPlan(t, forks, load);
  return plan;
}

function syncPlan(
  t: TemplateModel,
  forks: readonly ForkDef[],
  load?: LaneLoad,
): Paced & { skipped: string[]; skippedFrom: Set<AreaName> } {
  const head = t.head?.sha;
  const eligible: Target[] = [];
  const skipped: string[] = [];
  const skippedFrom = new Set<AreaName>(ROW_SOURCES);
  for (const row of t.rows) {
    if (!head || !row.behind) continue;
    if (row.pr?.headMarker === head) continue;
    const mirror = mirrored(row.repo, forks);
    if (mirror) {
      skipped.push(`${row.service} (${mirror})`);
      skippedFrom.add("fleet");
      continue;
    }
    if (row.syncing || row.dispatched) {
      skipped.push(`${row.service} (Sync Template ${row.syncing ? "running" : "dispatched"})`);
      if (row.syncing) skippedFrom.add("runs");
      continue;
    }
    const busy = inflight(load, row.repo);
    if (busy) {
      skipped.push(`${row.service} (${busy})`);
      for (const a of BUSY_SOURCES) skippedFrom.add(a);
      continue;
    }
    eligible.push({ repo: row.repo, kind: "workflow", state: "idle", label: row.service });
  }
  return { ...paced(eligible, load), skipped, skippedFrom };
}

export function rolloutTargets(
  t: TemplateModel,
  forks: readonly ForkDef[],
  load?: LaneLoad,
): Paced & { held: { row: TemplateRow; why: string }[] } {
  const { heldFrom: _, ...plan } = rolloutPlan(t, forks, load);
  return plan;
}

// Draft, review, merge state and verdict are the PR's own; a failure also reads its job details.
function heldSources(why: string): readonly AreaName[] {
  if (why.startsWith("fails ") || why === "is red on the stack") return ["github", "details"];
  return ["github"];
}

function rolloutPlan(
  t: TemplateModel,
  forks: readonly ForkDef[],
  load?: LaneLoad,
): Paced & { held: { row: TemplateRow; why: string }[]; heldFrom: Set<AreaName> } {
  const targets: Target[] = [];
  const held: { row: TemplateRow; why: string }[] = [];
  const heldFrom = new Set<AreaName>(["github"]);
  for (const row of t.rows) {
    const pr = row.pr;
    if (!pr) continue;
    const mirror = mirrored(row.repo, forks);
    const own = mirror ? undefined : heldBecause(row);
    const why =
      (mirror === "mirror"
        ? "is a mirror"
        : mirror
          ? "has its sync mode unread"
          : own) ?? busyText(inflight(load, row.repo));
    if (why) {
      held.push({ row, why });
      const from = mirror ? ["fleet" as const] : own ? heldSources(own) : BUSY_SOURCES;
      for (const a of from) heldFrom.add(a);
      continue;
    }
    targets.push({
      repo: row.repo,
      kind: "pr",
      number: pr.number,
      sha: pr.headSha,
      state: "open",
      label: `${row.service} #${pr.number}`,
    });
  }
  return { ...paced(targets, load), held, heldFrom };
}

function busyText(what: string | undefined): string | undefined {
  return what ? `has a lane in flight (${what})` : undefined;
}

const PLURAL_VERB: Record<string, string> = Object.freeze({
  is: "are",
  has: "have",
  needs: "need",
  fails: "fail",
});

function pluralVerb(why: string): string {
  const [verb, ...rest] = why.split(" ");
  return [PLURAL_VERB[verb as string] ?? verb, ...rest].join(" ");
}

export function heldText(held: readonly { row: TemplateRow; why: string }[]): string | undefined {
  if (held.length === 0) return undefined;
  const byWhy = new Map<string, string[]>();
  for (const h of held) {
    byWhy.set(h.why, [...(byWhy.get(h.why) ?? []), `${h.row.service} #${h.row.pr?.number}`]);
  }
  return [...byWhy.entries()]
    .map(([why, prs]) => `${names(prs)} ${prs.length > 1 ? pluralVerb(why) : why}`)
    .join("; ");
}

// What the cap means for this press, or nothing when the buttons are not paced.
export function paceText(load: LaneLoad | undefined, waiting: readonly Target[]): string[] {
  if (!load || load.cap === null) return [];
  if (load.unread) {
    return [
      `Paced to ${plural(load.cap, "lane")}, but ${load.unread} are not read yet, so nothing starts until a sweep reads them.`,
    ];
  }
  const busy = load.inflight.map((l) => l.service);
  const lines = [
    `Paced to ${plural(load.cap, "lane")} on the shared environment: ${busy.length} in flight now${busy.length ? ` (${names(busy)})` : ""}, and a press only tops up to ${load.cap}.`,
  ];
  if (waiting.length > 0) {
    lines.push(
      `${plural(waiting.length, "more fork")} ${waiting.length === 1 ? "waits" : "wait"} for the next press: ${names(waiting.map((w) => w.label))}.`,
    );
  }
  return lines;
}

function fullText(load: LaneLoad | undefined, waiting: readonly Target[]): string | undefined {
  if (!load || load.cap === null || waiting.length === 0) return undefined;
  if (load.unread) return `lanes unknown until ${load.unread} are read`;
  return `${load.inflight.length} of ${load.cap} lanes in flight; ${plural(waiting.length, "fork")} ${waiting.length === 1 ? "waits" : "wait"} for the next press`;
}

export function waitSuffix(waiting: readonly Target[]): string {
  return waiting.length > 0 ? ` · ${waiting.length} wait` : "";
}

export function rolloutActions(
  t: TemplateModel,
  binding: { swept: string },
  now: Date,
  forks: readonly ForkDef[],
  blocked?: string,
  load?: LaneLoad,
): ActionItem[] {
  const item = ROLLOUT_ITEM;
  const sync = syncPlan(t, forks, load);
  const head = t.steps[0]?.label ?? "main";
  const next = t.nextSync ? ` instead of at ${stamp(t.nextSync, now)}` : "";
  const syncFull = sync.targets.length === 0 ? fullText(load, sync.waiting) : undefined;
  const syncDisabled =
    blocked ??
    (sync.targets.length === 0
      ? (syncFull ??
        (sync.skipped.length > 0
          ? `nothing to dispatch: ${names(sync.skipped)}`
          : `every fork is on ${head} or its PR carries it`))
      : undefined);
  const syncFrom =
    blocked !== undefined
      ? []
      : syncFull && load
        ? loadSources(load)
        : sync.skipped.length > 0
          ? sync.skippedFrom
          : ROW_SOURCES;
  const roll = rolloutPlan(t, forks, load);
  const held = heldText(roll.held);
  const rollFull = roll.targets.length === 0 ? fullText(load, roll.waiting) : undefined;
  const rollDisabled =
    blocked ??
    (roll.targets.length === 0
      ? (rollFull ??
        (t.rows.some((r) => r.pr) ? `nothing is ready: ${held}` : "no template-sync PR is open"))
      : undefined);
  const rollFrom: Iterable<AreaName> =
    blocked !== undefined
      ? []
      : rollFull && load
        ? loadSources(load)
        : t.rows.some((r) => r.pr)
          ? roll.heldFrom
          : ["github"];
  const placeholder: Target = { repo: "Azure/osdu-spi", kind: "repo", label: "none" };
  const carried = [...new Set(t.rows.filter((r) => r.pr).map((r) => r.target ?? r.label))];
  return [
    sourced(verbAction(
      SYNC_FORKS,
      { item, swept: binding.swept, targets: sync.targets.length ? sync.targets : [placeholder] },
      {
        label: `Sync all forks · ${sync.targets.length}${waitSuffix(sync.waiting)}`,
        pending: `Dispatching ${sync.targets.length}…`,
        title: `Sync all forks · ${plural(sync.targets.length, "fork")}`,
        detail: [
          `Dispatches Sync Template on ${names(sync.targets.map((x) => x.label))}, so each template-sync PR moves to ${head} now${next}.`,
          ...paceText(load, sync.waiting),
          ...(sync.skipped.length ? [`Skipped: ${names(sync.skipped)}.`] : []),
          "A fork already on main, or whose PR carries it, is left alone.",
        ],
        ...(syncDisabled ? { disabled: syncDisabled } : {}),
      },
    ), syncFrom),
    sourced(verbAction(
      ROLL_OUT,
      { item, swept: binding.swept, targets: roll.targets.length ? roll.targets : [placeholder] },
      {
        label: `Roll out · ${roll.targets.length} ready${waitSuffix(roll.waiting)}`,
        pending: `Merging ${roll.targets.length}…`,
        title: `Roll out · ${plural(roll.targets.length, "template-sync PR")}`,
        detail: [
          `Merges ${names(roll.targets.map((x) => x.label))} into main with a merge commit${carried.length === 1 ? `, taking each fork to ${carried[0]}` : ""}.`,
          ...paceText(load, roll.waiting),
          ...(held ? [`Held back: ${held}.`] : []),
          "Each PR merges on its own; one that fails does not stop the others.",
        ],
        subject: {
          value: String(roll.targets.length),
          label: `Type ${roll.targets.length}: the number of PRs this merges into main`,
        },
        ...(rollDisabled ? { disabled: rollDisabled } : {}),
      },
    ), rollFrom),
  ];
}
