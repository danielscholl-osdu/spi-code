// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { LIFECYCLE_WORKFLOWS, shortRepo, STACK_REPO } from "../config.js";
import type { LaneLoad } from "../model/lanes.js";
import type { LaneRun, QueueItem } from "../model/queue.js";
import { runName, type StackModel, stoppedAttempts } from "../model/stack.js";
import { plural, stamp } from "../util.js";
import type { AreaName } from "../facts.js";
import { APP_VOICE, type Voice } from "../voice.js";
import { JUDGEMENT_SOURCES, loadSources, sourced } from "./reason-sources.js";
import { paced, paceText, waitSuffix } from "./rollout.js";
import { type ActionItem, type Target, type Verb, verbAction } from "./verbs.js";

export const RERUN_LANES: Verb = Object.freeze<Verb>({
  id: "rerun",
  label: "Re-run lanes",
  command: (t) => ["run", "rerun", String(t.number), "--failed", "-R", t.repo],
  paced: true,
});

export const DISPATCH_REFRESH: Verb = Object.freeze<Verb>({
  id: "dispatch-env-refresh",
  label: "Re-dispatch env-refresh",
  command: (t) => ["workflow", "run", LIFECYCLE_WORKFLOWS.refresh, "-R", t.repo],
});

export const DISPATCH_UPGRADE: Verb = Object.freeze<Verb>({
  id: "dispatch-env-upgrade",
  label: "Re-dispatch env-upgrade",
  command: (t) => ["workflow", "run", LIFECYCLE_WORKFLOWS.upgrade, "-R", t.repo],
});

export const WAIT_ACTION = "rerun-when-deployable";
export const NO_OPS = APP_VOICE.noOps;

function names(list: readonly string[]): string {
  return list.length <= 1
    ? (list[0] ?? "")
    : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

export function laneTargets(lanes: readonly LaneRun[]): Target[] {
  const perPr = new Map<string, number>();
  for (const l of lanes) perPr.set(`${l.repo}#${l.pr}`, (perPr.get(`${l.repo}#${l.pr}`) ?? 0) + 1);
  return lanes.map((l) => ({
    repo: l.repo,
    kind: "run",
    number: l.runId,
    pr: l.pr,
    sha: l.headSha,
    state: "failure",
    label: `${l.service} #${l.pr}${(perPr.get(`${l.repo}#${l.pr}`) ?? 0) > 1 ? ` run ${l.runId}` : ""}`,
  }));
}

function steps(lanes: readonly LaneRun[]): string[] {
  return [...new Set(lanes.flatMap((l) => (l.step ? [l.step] : [])))];
}

// "schema #37 run 38481923150"; each lane's step is named only when they differ.
function laneLine(lanes: readonly LaneRun[]): string {
  const each = steps(lanes).length > 1;
  const list = lanes.map(
    (l) => `${l.service} #${l.pr} run ${l.runId}${each && l.step ? ` (${l.step})` : ""}`,
  );
  return `${lanes.length === 1 ? "Lane" : "Lanes"}: ${names(list)}.`;
}

function stepText(lanes: readonly LaneRun[]): string {
  const found = steps(lanes);
  const who = lanes.length === 1 ? "The lane" : "Each lane";
  return `${who} failed in ${found.length > 0 ? names(found) : "a step"}, on the shared stack rather than the code, so only the failed jobs run again.`;
}

export interface LaneOptions {
  swept: string;
  now: Date;
  blocked?: string;
  // The harness offers registerOp.
  ops: boolean;
  voice?: Voice;
  // A wait already holds this item.
  waiting?: { id: string; at: string };
  load?: LaneLoad;
}

// Re-run lanes while the stack is deployable; otherwise a wait that re-runs them once it is.
export function laneActions(item: QueueItem, stack: StackModel, given: LaneOptions): ActionItem[] {
  const voice = given.voice ?? APP_VOICE;
  const lanes = item.lanes ?? [];
  if (lanes.length === 0) return [];
  const targets = laneTargets(lanes);
  const binding = { item: item.id, swept: given.swept, targets };
  const n = lanes.length;
  const stop =
    item.judgement?.response === "stop"
      ? `stop the line${item.judgement.note ? ` (${item.judgement.note})` : ""}: fix it forward in the template, no re-run`
      : undefined;
  const opts = stop && !given.blocked ? { ...given, blocked: stop } : given;
  const blockedFrom: readonly AreaName[] = given.blocked ? [] : JUDGEMENT_SOURCES;
  if (stack.deployable.state === "yes") {
    const since = stamp(stack.lastGreen?.updatedAt, opts.now);
    const busy = new Set(opts.load?.inflight.map((l) => l.repo));
    const now = paced(
      targets.filter((t) => !busy.has(t.repo)),
      opts.load,
    );
    const go = lanes.filter((l) => now.targets.some((t) => t.number === l.runId));
    const k = go.length;
    const full =
      k === 0 && opts.load?.cap && opts.load.unread
        ? `lanes unknown until ${opts.load.unread} are read`
        : k === 0 && opts.load?.cap
          ? `${opts.load.inflight.length} of ${opts.load.cap} lanes in flight; ${plural(n, "lane")} ${n === 1 ? "waits" : "wait"} for the next press`
          : undefined;
    const from = opts.blocked ? blockedFrom : opts.load && loadSources(opts.load);
    return [
      sourced(verbAction(
        RERUN_LANES,
        { ...binding, targets: k > 0 ? now.targets : targets },
        {
          primary: true,
          label: `Re-run lanes · ${k > 0 ? k : n}${waitSuffix(now.waiting)}`,
          pending: `Re-running ${k}…`,
          title: `Re-run ${plural(k, "failed lane")}`,
          detail: [
            `The stack has been deployable${since ? ` since ${since}` : ""}. ${stepText(go.length ? go : lanes)}`,
            ...paceText(opts.load, now.waiting),
            laneLine(go.length ? go : lanes),
          ],
          ...((opts.blocked ?? full) ? { disabled: opts.blocked ?? full } : {}),
        },
      ), from),
    ];
  }
  const disabled =
    opts.blocked ??
    (!opts.ops
      ? voice.noOps
      : opts.waiting
        ? `already waiting since ${stamp(opts.waiting.at, opts.now)} as op ${opts.waiting.id}; run_cancel drops it`
        : undefined);
  const wait = (action: ActionItem) =>
    sourced({ ...action, type: WAIT_ACTION }, opts.blocked ? blockedFrom : []);
  return [
    wait(
      verbAction(RERUN_LANES, binding, {
        primary: true,
        label: "Re-run when deployable",
        pending: "Setting the wait…",
        title: `Re-run ${plural(n, "failed lane")} when deployable`,
        detail: [
          `The stack is not deployable now (${stack.deployable.reason}). A wait holds ${n === 1 ? "this lane" : `these ${n} lanes`} and, on the first sweep that reads deployable, re-runs ${n === 1 ? "it" : "them"} through the same calls.`,
          `It stands down without writing if a lifecycle run fails again. ${voice.restart} drops the wait and the item stays in the queue.`,
          ...(opts.load?.cap
            ? [
                `When it fires, it re-runs only as many lanes as the ${opts.load.cap}-lane cap leaves room for; the rest stay in the queue for the next press.`,
              ]
            : []),
          laneLine(lanes),
        ],
        ...(disabled ? { disabled } : {}),
      }),
    ),
  ];
}

// The lifecycle run a person re-dispatches: the kind that last stopped, or refresh for a bare hold.
function primaryKind(item: QueueItem, stack: StackModel): "refresh" | "upgrade" {
  if (item.kind !== "stack") return "refresh";
  return stoppedAttempts(stack).at(-1)?.run.kind === "upgrade" ? "upgrade" : "refresh";
}

export function dispatchActions(
  item: QueueItem,
  stack: StackModel,
  opts: { swept: string; blocked?: string; stackRepo?: string },
): ActionItem[] {
  if (item.kind !== "stack" && item.kind !== "maintenance") return [];
  const stackRepo = opts.stackRepo ?? STACK_REPO;
  const busy = stack.inflight
    ? `${runName(stack.inflight.run)} is ${stack.inflight.run.status === "queued" ? "queued" : "running"} in concurrency group env-shared`
    : undefined;
  const disabled = opts.blocked ?? busy;
  const from: AreaName[] = opts.blocked ? [] : ["lifecycle"];
  const primary = primaryKind(item, stack);
  const shared =
    "env-refresh and env-upgrade share concurrency group env-shared, so this is refused while either one is queued or running.";
  const target = (label: string): Target => ({
    repo: stackRepo,
    kind: "workflow",
    state: "idle",
    label,
  });
  const refresh = sourced(verbAction(
    DISPATCH_REFRESH,
    { item: item.id, swept: opts.swept, targets: [target("env-refresh")] },
    {
      primary: primary === "refresh",
      pending: "Dispatching…",
      title: `Re-dispatch env-refresh · ${shortRepo(stackRepo)}`,
      detail: [
        "Runs env-refresh on the shared environment: quiesce, reconcile the pinned source, wait for Flux, probe the gateway, then reopen for deploys.",
        "It clears maintenance only after its probes pass; the board has no verb that clears maintenance directly.",
        shared,
      ],
      ...(disabled ? { disabled } : {}),
    },
  ), from);
  const upgrade = sourced(verbAction(
    DISPATCH_UPGRADE,
    { item: item.id, swept: opts.swept, targets: [target("env-upgrade")] },
    {
      primary: primary === "upgrade",
      pending: "Dispatching…",
      title: `Re-dispatch env-upgrade · ${shortRepo(stackRepo)}`,
      detail: [
        `Runs env-upgrade, which deploys the declared stackVersion${stack.declared ? ` ${stack.declared}` : ""} from ops/environments/shared.yaml onto the shared environment. It takes no inputs.`,
        "It clears maintenance only after its verify stage passes.",
        shared,
      ],
      ...(disabled ? { disabled } : {}),
    },
  ), from);
  return primary === "upgrade" ? [upgrade, refresh] : [refresh, upgrade];
}
