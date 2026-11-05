// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ActionItem } from "../act/action-item.js";
import { APPROVE_RUNS, approveAction } from "../act/approve.js";
import { FLEET_RELEASE } from "../act/flow.js";
import { DISPATCH_REFRESH, DISPATCH_UPGRADE, dispatchActions, laneActions, RERUN_LANES } from "../act/rerun.js";
import { ROLL_OUT, rolloutActions, SYNC_FORKS, syncTargets, waitSuffix } from "../act/rollout.js";
import { upstreamVerbs } from "../act/upstream.js";
import { createRegistry, type VerbRegistry, writeBlocked } from "../act/verbs.js";
import type { CoreContext } from "../context.js";
import type { Model } from "../model/index.js";
import { associationText, diffText, type QueueItem } from "../model/queue.js";
import type { CanvasTone } from "../tone.js";
import { plural } from "../util.js";
import type { InspectField } from "./item.js";

export interface InspectOptions {
  scopes?: string[];
  ops?: boolean;
  waiting?: { id: string; at: string };
}

export interface ApprovalSection {
  title: string;
  items: {
    title: string;
    href: string;
    pill?: { label: string; tone: CanvasTone };
    fields: InspectField[];
    actions: ActionItem[];
  }[];
}

export function createInspectRegistry(): VerbRegistry {
  const registry = createRegistry();
  for (const verb of [APPROVE_RUNS, RERUN_LANES, DISPATCH_REFRESH, DISPATCH_UPGRADE, SYNC_FORKS, ROLL_OUT, FLEET_RELEASE]) {
    registry.registerVerb(verb);
  }
  upstreamVerbs(registry);
  return registry;
}

export function approvalSection(
  item: QueueItem,
  model: Model,
  opts: InspectOptions = {},
): ApprovalSection | undefined {
  const approve = item.approve ?? [];
  if (approve.length === 0) return undefined;
  const disabled = writeBlocked(model.sweptAt, opts.scopes);
  const swept = model.sweptAt ?? "";
  return {
    title: `Outside PRs · ${approve.length}`,
    items: approve.map((a) => {
      const pill =
        a.workflowFiles.length > 0
          ? { label: "changes .github", tone: "caution" as const }
          : a.pr.draft
            ? { label: "draft", tone: "neutral" as const }
            : undefined;
      return {
        title: `#${a.pr.number} ${a.pr.title}`,
        href: a.pr.url,
        ...(pill ? { pill } : {}),
        fields: [
          { label: "by", value: `${a.pr.author} · ${associationText(a.pr.association)}` },
          { label: "diff", value: diffText(a.pr) },
          { label: "waiting", value: plural(a.runs.length, "run") },
        ],
        actions: [approveAction(a, { item: item.id, swept }, disabled)],
      };
    }),
  };
}

function syncNamed(action: ActionItem, model: Model, context: CoreContext): ActionItem {
  const sync = syncTargets(model.template, context.fleet.forks, model.lanes);
  const forks = sync.targets.map((t) => t.label);
  if (forks.length === 0) return action;
  const label = `Sync all forks · ${forks.length <= 3 ? forks.join(", ") : forks.length}${waitSuffix(sync.waiting)}`;
  return {
    ...action,
    label,
    ...(action.confirm ? { confirm: { ...action.confirm, confirmLabel: label } } : {}),
  };
}

export function rolloutActionItems(
  model: Model,
  context: CoreContext,
  blocked?: string,
): ActionItem[] {
  return rolloutActions(
    model.template,
    { swept: model.sweptAt ?? "" },
    context.clock.now(),
    context.fleet.forks,
    blocked,
    model.lanes,
  ).map((a) => (a.label.startsWith("Sync all forks") ? syncNamed(a, model, context) : a));
}

export function verbsOf(
  item: QueueItem,
  model: Model,
  context: CoreContext,
  opts: InspectOptions = {},
): ActionItem[] {
  const blocked = writeBlocked(model.sweptAt, opts.scopes);
  const swept = model.sweptAt ?? "";
  if (item.kind === "template-set") return rolloutActionItems(model, context, blocked);
  return item.kind === "lanes"
    ? laneActions(item, model.stack, {
        swept,
        now: context.clock.now(),
        ops: opts.ops ?? false,
        load: model.lanes,
        ...(blocked ? { blocked } : {}),
        ...(opts.waiting ? { waiting: opts.waiting } : {}),
      })
    : dispatchActions(item, model.stack, { swept, stackRepo: context.stackRepo, ...(blocked ? { blocked } : {}) });
}
