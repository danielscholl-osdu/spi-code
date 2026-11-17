// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Model } from "../model/index.js";
import type { ItemKind, QueueItem } from "../model/queue.js";

/** What a link opens; other when core does not know the URL's shape. */
export type LinkKind =
  | "pr"
  | "issue"
  | "mr"
  | "run"
  | "job"
  | "commit"
  | "compare"
  | "deploy"
  | "other";

const REPO = String.raw`^/[^/]+/[^/]+`;
const SHA = "[0-9a-f]{7,40}";
const COMPARE = String.raw`/compare/[^?#]+\.\.[^?#]+$`;

const GITHUB: readonly (readonly [RegExp, LinkKind])[] = [
  [new RegExp(`${REPO}/pull/\\d+/?$`), "pr"],
  [new RegExp(`${REPO}/issues/\\d+/?$`), "issue"],
  [new RegExp(`${REPO}/actions/runs/\\d+(/attempts/\\d+)?/?$`), "run"],
  [new RegExp(`${REPO}/actions/runs/\\d+/job/\\d+/?$`), "job"],
  [new RegExp(`${REPO}/commit/${SHA}/?$`), "commit"],
  [new RegExp(`${REPO}${COMPARE}`), "compare"],
  [new RegExp(`${REPO}/deployments/?$`), "deploy"],
];

const GITLAB: readonly (readonly [RegExp, LinkKind])[] = [
  [/^\/.+\/-\/merge_requests\/\d+\/?$/, "mr"],
  [/^\/.+\/-\/issues\/\d+\/?$/, "issue"],
  [/^\/.+\/-\/pipelines\/\d+\/?$/, "run"],
  [/^\/.+\/-\/jobs\/\d+\/?$/, "job"],
  [new RegExp(`^/.+/-/commit/${SHA}/?$`), "commit"],
  [new RegExp(`^/.+/-${COMPARE}`), "compare"],
];

/** What a link opens, from its URL's shape on GitHub or GitLab; other when the shape is unknown. */
export function linkKind(url: string): LinkKind {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "other";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "other";
  const shapes = parsed.hostname === "github.com" ? GITHUB : GITLAB;
  return shapes.find(([shape]) => shape.test(parsed.pathname))?.[1] ?? "other";
}

// Kinds whose move acts on several objects at once: lanes, PRs, forks.
const SEVERAL: ReadonlySet<ItemKind> = new Set([
  "lanes",
  "approvals",
  "releases",
  "template-set",
  "rollout",
]);

/**
 * The URL of the one object an item's next move acts on, so items on one PR share it: a toolchain
 * move rides the sync PR that holds it. None when the move acts on several objects.
 */
export function subjectOf(model: Model, item: QueueItem, heldPr: number | undefined): string | undefined {
  if (SEVERAL.has(item.kind)) return undefined;
  const line = model.lines.find((l) => l.fork.id === item.scope);
  if (item.kind === "radar" && item.cls === "TOOLCHAIN" && heldPr !== undefined) {
    return line?.syncPr?.pr.number === heldPr ? line.syncPr.pr.url : undefined;
  }
  if (item.kind === "access") {
    return line?.prs.find((p) => item.id === `access:${p.pr.repo}#${p.pr.number}`)?.pr.url;
  }
  return item.url;
}

/**
 * The item whose move must come first: a sync or release/upstream PR red only on the environment
 * waits for the stack or lanes item that folded its failure. None when that item is not in the list.
 */
export function blockerOf(
  model: Model,
  item: QueueItem,
  items: readonly QueueItem[],
): string | undefined {
  if ((item.kind !== "gate1" && item.kind !== "gate2") || item.cls !== undefined) return undefined;
  const line = model.lines.find((l) => l.fork.id === item.scope);
  const pr = item.kind === "gate1" ? line?.syncPr : line?.cascadePr;
  const urls = new Set(
    (pr?.failures ?? []).filter((f) => f.cls === "ENV").map((f) => f.url ?? f.prUrl),
  );
  if (urls.size === 0) return undefined;
  return items.find(
    (b) =>
      (b.kind === "stack" || b.kind === "lanes") &&
      b.effects.some((e) => e.url !== undefined && urls.has(e.url)),
  )?.id;
}
