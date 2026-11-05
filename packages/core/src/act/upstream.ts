// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type LaneLoad, laneRoom } from "../model/lanes.js";
import {
  planStep,
  UPSTREAM_ITEM,
  UPSTREAM_PREFIX,
  type UpFork,
  type UpstreamModel,
} from "../model/upstream.js";
import { names, plural, whose } from "../util.js";
import {
  cascadeAction,
  DISPATCH_CASCADE,
  PREPARE,
  prepareAction,
  RERUN_CASCADE,
  START,
  startAction,
} from "./upstream-targets.js";
import type { ActionItem, VerbRegistry } from "./verbs.js";

export { UPSTREAM_ITEM, UPSTREAM_PREFIX };

function services(list: readonly UpFork[]): string {
  return names(list.map((f) => f.service));
}

function disabled(label: string, reason: string): ActionItem {
  return { type: "act", label, disabled: true, reason };
}

function waiting(label: string, reason: string): ActionItem {
  return disabled(`${label} · ${reason}`, reason);
}

export interface UpstreamActions {
  primary: ActionItem;
  secondary: ActionItem[];
}

function blockAll(a: UpstreamActions, blocked?: string): UpstreamActions {
  if (!blocked) return a;
  const off = (x: ActionItem) => (x.disabled ? x : disabled(x.label, blocked));
  return { primary: off(a.primary), secondary: a.secondary.map(off) };
}

export function planActions(
  u: UpstreamModel,
  opts: { swept: string; load: LaneLoad; now: Date; blocked?: string },
): UpstreamActions {
  const base = { swept: opts.swept, item: UPSTREAM_ITEM };
  const secondary: ActionItem[] = [];
  let primary: ActionItem | undefined;
  const group = (list: readonly UpFork[]) =>
    list.every((f) => f.role === "pilot")
      ? "the pilot"
      : list.every((f) => f.wave === list[0]?.wave)
        ? `wave ${list[0]?.wave}`
        : services(list);

  const step = planStep(u);
  switch (step.kind) {
    case "start":
      primary = startAction(u, step.forks, {
        ...base,
        load: opts.load,
        primary: true,
        label: `Start ${services(step.forks)} · merge the sync PR${step.forks.length > 1 ? "s" : ""}, dispatch the cascade`,
      });
      break;
    case "dispatch":
      primary = cascadeAction(DISPATCH_CASCADE, u, step.forks, {
        ...base,
        now: opts.now,
        primary: true,
      });
      break;
    case "prepare":
      primary = prepareAction(u, step.forks, {
        ...base,
        now: opts.now,
        primary: true,
        label: `Prepare ${group(step.forks)} · dispatch Sync Upstream on ${plural(step.forks.length, "fork")}`,
      });
      break;
    case "rerun":
      primary = cascadeAction(RERUN_CASCADE, u, step.forks, {
        ...base,
        now: opts.now,
        primary: true,
      });
      break;
    case "paused":
      primary = disabled(
        `Paused · ${names(u.paused?.forks ?? [])} failed the cascade the same way`,
        "absorb the move in the remaining forks first",
      );
      break;
    case "env":
      primary = disabled(
        `Waiting for the environment · ${u.envHeld}`,
        "Start resumes once it reads deployable",
      );
      break;
    case "early":
      primary = prepareAction(u, step.forks, {
        ...base,
        now: opts.now,
        primary: true,
        label: `Prepare ${group(step.forks)} early · ${plural(step.forks.length, "fork")}`,
        extra: [`Their Start still waits: ${step.forks[0]?.planWait ?? "for their wave"}.`],
      });
      break;
  }
  if (!primary) {
    const why =
      u.startWaits.length > 0
        ? `${services(u.startWaits)} ${u.startWaits.length === 1 ? "waits" : "wait"} for a lane`
        : u.reviews.length > 0
          ? `review ${services(u.reviews)} on GitHub`
          : u.forks.some((f) => f.phase === "cascading")
            ? "cascades are running"
            : "nothing waits on a press";
    primary = disabled(`Nothing to press yet · ${why}`, why);
  }

  if (primary.binding?.verb !== START.id && u.startWaits.length > 0) {
    secondary.push(waiting(`Start ${services(u.startWaits)}`, "waits for a lane"));
  }
  const early = (list: readonly UpFork[]) =>
    prepareAction(u, list, {
      ...base,
      now: opts.now,
      label: `Prepare ${group(list)} early · ${plural(list.length, "fork")}`,
      extra: [`Their Start still waits: ${list[0]?.planWait ?? "for their wave"}.`],
    });
  const preparing = primary.binding?.verb === PREPARE.id;
  if (!preparing && u.prepareNext.length > 0) {
    secondary.push(prepareAction(u, u.prepareNext, { ...base, now: opts.now }));
  } else if (preparing && step.kind !== "early" && u.prepareLater.length > 0) {
    secondary.push(early(u.prepareLater));
  }
  if (primary.binding?.verb !== RERUN_CASCADE.id) {
    if (u.reruns.length > 0) {
      secondary.push(cascadeAction(RERUN_CASCADE, u, u.reruns, { ...base, now: opts.now }));
    }
    for (const f of u.stops) {
      const why = f.wait ?? f.planWait;
      if (why) secondary.push(waiting(`Re-run ${whose(f.service)} cascade`, why));
    }
  }
  return blockAll({ primary, secondary }, opts.blocked);
}

export function forkActions(
  u: UpstreamModel,
  f: UpFork,
  opts: { swept: string; load: LaneLoad; now: Date; blocked?: string },
): UpstreamActions {
  const base = { swept: opts.swept, item: `${UPSTREAM_PREFIX}${f.service}` };
  const room = laneRoom(opts.load);
  const anyway =
    f.held === "snapshot"
      ? [
          `The plan holds ${f.service}: upstream moved to ${f.snapshot}, and a SNAPSHOT can change under the same version. Pressing takes it anyway.`,
        ]
      : [];
  let primary: ActionItem;
  switch (f.verb) {
    case "prepare":
      primary = f.wait
        ? waiting("Prepare", f.wait)
        : prepareAction(u, [f], {
            ...base,
            now: opts.now,
            primary: true,
            label:
              f.held === "snapshot"
                ? "Take it anyway · Prepare"
                : "Prepare · dispatch Sync Upstream",
            extra: anyway,
          });
      break;
    case "start":
      primary = f.wait
        ? waiting("Start", f.wait)
        : room <= 0
          ? waiting(
              "Start",
              opts.load.unread
                ? `lanes unknown until ${opts.load.unread} are read`
                : "waits for a lane",
            )
          : startAction(u, [f], {
              ...base,
              load: opts.load,
              primary: true,
              label: `${f.held === "snapshot" ? "Take it anyway · " : ""}Start · merge #${f.syncPr?.number}, dispatch the cascade`,
              extra: [
                ...anyway,
                ...(f.planWait && f.held !== "snapshot"
                  ? [`The plan would wait: ${f.planWait}.`]
                  : []),
              ],
            });
      break;
    case "dispatch":
      primary = f.wait
        ? waiting("Dispatch cascade", f.wait)
        : room <= 0
          ? waiting("Dispatch cascade", "waits for a lane")
          : cascadeAction(DISPATCH_CASCADE, u, [f], { ...base, now: opts.now, primary: true });
      break;
    case "rerun":
      primary = f.wait
        ? waiting("Re-run the cascade", f.wait)
        : room <= 0
          ? waiting("Re-run the cascade", "waits for a lane")
          : cascadeAction(RERUN_CASCADE, u, [f], {
              ...base,
              now: opts.now,
              primary: true,
              label: "Re-run the cascade",
            });
      break;
    default:
      primary = disabled(
        "Nothing to press",
        f.phase === "review"
          ? "the Sync to Main PR auto-merges when green"
          : f.phase === "cascading"
            ? "the cascade is running"
            : f.phase === "main"
              ? "the main run is testing"
              : (f.wait ?? "nothing waits on a press"),
      );
  }
  const secondary: ActionItem[] = [];
  if (f.phase === "stopped" && f.syncPr) {
    secondary.push(waiting(`Start #${f.syncPr.number}`, "once this cascade clears"));
  }
  return blockAll({ primary, secondary }, opts.blocked);
}

export function upstreamVerbs(registry: VerbRegistry): void {
  for (const verb of [PREPARE, START, DISPATCH_CASCADE, RERUN_CASCADE]) {
    registry.registerVerb(verb);
  }
}
