// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";
import { useStore } from "zustand";
import { navigate } from "../app/navigation.js";
import { type PendingRequest, pendingRequests } from "./request-ownership.js";
import { threadStore } from "./store.js";
import "./request-owner.css";

export function usePendingRequests(
  sweep: ViewSnapshot | null | undefined,
  scope?: string,
  forge?: "github" | "gitlab",
): PendingRequest[] {
  const threads = useStore(threadStore, (state) => state.threads);
  return pendingRequests(threads, sweep).filter(
    ({ thread, request }) =>
      (scope === undefined || thread.thread.scope === scope) &&
      (forge === undefined || request.forge === forge),
  );
}

/**
 * Requests threads opened that this sweep has not read: dashed, from the thread store, until a
 * sweep's PR or MR row holds it and its RequestOwner draws it solid instead.
 */
export function PendingRequests({
  sweep,
  scope,
  forge,
  fork = false,
}: {
  sweep: ViewSnapshot | null | undefined;
  scope?: string;
  forge?: "github" | "gitlab";
  /** Name each request's fork, where the list spans forks. */
  fork?: boolean;
}) {
  const shown = usePendingRequests(sweep, scope, forge);
  if (!shown.length) return null;
  return (
    <ul className="request-pending-list" aria-label="Opened by threads">
      {shown.map((entry) => (
        <Pending key={entry.request.url} entry={entry} fork={fork} />
      ))}
    </ul>
  );
}

function Pending({ entry: { thread, request }, fork }: { entry: PendingRequest; fork: boolean }) {
  const github = request.forge === "github";
  const title = thread.thread.title ?? "Untitled thread";
  return (
    <li className="request-pending" data-state="pending" data-request={request.url}>
      <span className="request-pending-tag">{github ? "pull request" : "merge request"}</span>
      <span>
        <button
          type="button"
          title={request.url}
          onClick={() => navigate({ kind: "thread", id: thread.id })}
        >
          {title} · {github ? "#" : "!"}
          {request.requestNumber}
        </button>
        <span className="request-pending-sub">
          {fork && `${thread.thread.scope} · `}opened by the thread · pending · not yet in a sweep
        </span>
      </span>
    </li>
  );
}
