// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useStore } from "zustand";
import { navigate } from "../app/navigation.js";
import { isReachable, useRegistry } from "../app/routes.js";
import { useNow } from "../components/evidence/useNow.js";
import { Icon } from "../components/icons/Icon.js";
import { age } from "../components/sidebar/ThreadRows.js";
import { scopeLabel } from "./scopes.js";
import { askIn } from "./start.js";
import { NEW_THREAD, type ThreadSummary, threadStore } from "./store.js";
import "./scope-threads.css";

const needsAttention = ({ status }: ThreadSummary) =>
  status === "Waiting on you" || status === "Working";

/** How many of a scope's threads are Waiting on you or Working; null until the host lists them. */
export function activeThreadCount(
  threads: readonly ThreadSummary[] | null | undefined,
  scope: string,
): number | null {
  if (!threads) return null;
  return threads.filter((thread) => thread.thread.scope === scope && needsAttention(thread)).length;
}

function Row({ thread, now }: { thread: ThreadSummary; now: number }) {
  return (
    <li>
      <button
        type="button"
        className="scope-thread"
        data-thread-row={thread.id}
        data-status={thread.status}
        onClick={() => navigate({ kind: "thread", id: thread.id })}
      >
        <span className="scope-thread-title">{thread.thread.title ?? "Untitled thread"}</span>
        <span className="scope-thread-status">
          {thread.status === "Open" || thread.status === "Settled"
            ? age(thread.updatedAt, now)
            : thread.status}
        </span>
      </button>
    </li>
  );
}

/** Every thread in one scope, newest first, the settled ones under a fold, and New thread. */
export function ScopeThreads({ scope }: { scope: string }) {
  const threads = useStore(threadStore, (state) => state.threads);
  const now = useNow(60_000);
  const registry = useRegistry();
  if (!isReachable({ kind: "thread", id: NEW_THREAD }, registry)) return null;
  const label = scopeLabel(scope);
  const mine = (threads ?? [])
    .filter((thread) => thread.thread.scope === scope && thread.status !== "Can't be read")
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const open = mine.filter(({ status }) => status !== "Settled");
  const settled = mine.filter(({ status }) => status === "Settled");
  return (
    <section className="scope-threads" aria-label={`${label} threads`}>
      <div className="scope-threads-head">
        <h2>Threads</h2>
        <button type="button" className="scope-threads-new" onClick={() => askIn(scope)}>
          <Icon name="squarePen" size={14} />
          New thread
        </button>
      </div>
      {threads === null ? (
        <p className="scope-threads-quiet" data-quiet="not-read">
          ⌀ Threads were not listed.
        </p>
      ) : (
        mine.length === 0 && (
          <p className="scope-threads-quiet" data-quiet="none">
            No threads in {label}.
          </p>
        )
      )}
      {open.length > 0 && (
        <ul className="scope-threads-list">
          {open.map((thread) => (
            <Row key={thread.id} thread={thread} now={now} />
          ))}
        </ul>
      )}
      {settled.length > 0 && (
        <details className="scope-threads-settled">
          <summary>
            Settled <span className="scope-threads-count">{settled.length}</span>
          </summary>
          <ul className="scope-threads-list">
            {settled.map((thread) => (
              <Row key={thread.id} thread={thread} now={now} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
