// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ThreadSummary } from "./store.js";

export function requestInSweep(value: unknown, url: string): boolean {
  if (value === url) return true;
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => requestInSweep(entry, url));
  return Object.values(value).some((entry) => requestInSweep(entry, url));
}

export function threadOwningRequest(
  threads: readonly ThreadSummary[] | null | undefined,
  subject: string | undefined,
  urls: readonly string[] = [],
): ThreadSummary | undefined {
  return threads?.find(
    (thread) =>
      (subject !== undefined && thread.thread.subject === subject) ||
      (thread.thread.request !== undefined && urls.includes(thread.thread.request.url)),
  );
}

export type PendingRequest = {
  thread: ThreadSummary;
  request: NonNullable<ThreadSummary["thread"]["request"]>;
};

/** The requests threads opened that no row of this sweep holds yet, so they are drawn from the store. */
export function pendingRequests(
  threads: readonly ThreadSummary[] | null | undefined,
  sweep: unknown,
): PendingRequest[] {
  return (threads ?? []).flatMap((thread) => {
    const request = thread.thread.request;
    return request && !requestInSweep(sweep, request.url) ? [{ thread, request }] : [];
  });
}
