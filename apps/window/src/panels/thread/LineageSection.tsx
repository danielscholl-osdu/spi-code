// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useStore } from "zustand";
import { navigate, routeHash } from "../../app/navigation.js";
import { scopeLabel } from "../../threads/scopes.js";
import { type ThreadSummary, threadStore } from "../../threads/store.js";
import type { ThreadSection } from "./section.js";
import type { ThreadTabProps } from "./tab.js";
import "./lineage.css";

function ThreadLink({ thread, lead }: { thread: ThreadSummary; lead: string }) {
  const route = { kind: "thread", id: thread.id } as const;
  return (
    <a
      className="thread-lineage-link"
      href={routeHash(route)}
      data-lineage={thread.id}
      onClick={(event) => {
        event.preventDefault();
        navigate(route);
      }}
    >
      {`${lead} ${thread.thread.title ?? "Untitled thread"} · ${scopeLabel(thread.thread.scope)}`}
    </a>
  );
}

/** The thread this one continues and the threads that continue it. */
function Lineage({ id, summary }: ThreadTabProps) {
  const threads = useStore(threadStore, (state) => state.threads);
  if (!summary || !threads) return <span data-quiet="not-known">⌀ Not known</span>;
  const { parent } = summary.thread;
  const from = parent ? threads.find((thread) => thread.id === parent) : undefined;
  const children = threads.filter((thread) => thread.thread.parent === id);
  if (!parent && children.length === 0)
    return <span className="thread-field-quiet">None. No thread continues another here.</span>;
  return (
    <>
      {parent &&
        (from ? (
          <ThreadLink thread={from} lead="Continues" />
        ) : (
          <span data-quiet="not-known">⌀ Continues a thread the host no longer lists.</span>
        ))}
      {children.map((child) => (
        <ThreadLink key={child.id} thread={child} lead="Continued in" />
      ))}
    </>
  );
}

export const LINEAGE_SECTION: ThreadSection = { id: "lineage", label: "Lineage", Field: Lineage };
