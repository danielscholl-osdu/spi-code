// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { todayMembers, type ViewSnapshot } from "@spi-code/contracts";
import type { ThreadSummary } from "./store.js";

const PULL = /^\/(.+?)\/pull\/(\d+)\/?$/u;
const MERGE = /^\/(.+?)(?:\/-)?\/merge_requests\/(\d+)\/?$/u;

/** One key per PR or MR, whatever spelling of its URL a store or a sweep carries. */
export function requestKey(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const pull = PULL.exec(parsed.pathname);
  if (pull) return `pr ${parsed.host}/${pull[1]}#${pull[2]}`;
  const merge = MERGE.exec(parsed.pathname);
  if (merge) return `mr ${parsed.host}/${merge[1]}!${merge[2]}`;
  return url;
}

const PR_CAUSES = new Set(["release", "dependabot", "other"]);

/** The PR and MR rows a sweep draws, by their own URL. */
function sweptRequests(snapshot: ViewSnapshot): Set<string> {
  const urls: string[] = [];
  for (const { member } of todayMembers(snapshot.briefing)) {
    if (member.primary?.kind === "pr" || member.primary?.kind === "mr")
      urls.push(member.primary.url);
  }
  for (const cause of snapshot.briefing.today?.causes?.rows ?? []) {
    if (!PR_CAUSES.has(cause.kind)) continue;
    for (const fork of cause.forks) for (const { url } of fork.objects) urls.push(url);
  }
  for (const { work, upstreamSecurity } of snapshot.services ?? []) {
    for (const { url } of work?.pulls.rows ?? []) urls.push(url);
    for (const { url } of upstreamSecurity?.upstream.open.list?.shown ?? []) urls.push(url);
  }
  return new Set(urls.map(requestKey));
}

const swept = new WeakMap<ViewSnapshot, Set<string>>();

export function requestInSweep(snapshot: ViewSnapshot | null | undefined, url: string): boolean {
  if (!snapshot) return false;
  let keys = swept.get(snapshot);
  if (!keys) {
    keys = sweptRequests(snapshot);
    swept.set(snapshot, keys);
  }
  return keys.has(requestKey(url));
}

export function threadOwningRequest(
  threads: readonly ThreadSummary[] | null | undefined,
  subject: string | undefined,
  urls: readonly string[] = [],
): ThreadSummary | undefined {
  const keys = new Set(urls.map(requestKey));
  return threads?.find(
    (thread) =>
      (subject !== undefined && thread.thread.subject === subject) ||
      (thread.thread.request !== undefined && keys.has(requestKey(thread.thread.request.url))),
  );
}

export type PendingRequest = {
  thread: ThreadSummary;
  request: NonNullable<ThreadSummary["thread"]["request"]>;
};

/** The requests threads opened that no PR or MR row of this sweep holds yet, so they are drawn from the store. */
export function pendingRequests(
  threads: readonly ThreadSummary[] | null | undefined,
  sweep: ViewSnapshot | null | undefined,
): PendingRequest[] {
  return (threads ?? []).flatMap((thread) => {
    const request = thread.thread.request;
    return request && !requestInSweep(sweep, request.url) ? [{ thread, request }] : [];
  });
}
