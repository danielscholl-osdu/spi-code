// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ReactNode, useEffect, useState } from "react";
import { useStore } from "zustand";
import { changesStore, diffOf } from "./changes-store.js";
import type { ThreadTab, ThreadTabProps } from "./tab.js";
import { useChanges, useReadWhileShown } from "./useChanges.js";
import "./thread-tab.css";

type File = Extract<NonNullable<ReturnType<typeof useChanges>>, { state: "read" }>["files"][number];

function counts({ added, removed, untracked }: File): string {
  if (added === null || removed === null) return untracked ? "new · not counted" : "binary";
  return `${untracked ? "new · " : ""}+${added} −${removed}`;
}

const kind = (line: string) =>
  /^(?:\+\+\+|---) /u.test(line)
    ? undefined
    : line.startsWith("+")
      ? "added"
      : line.startsWith("-")
        ? "removed"
        : undefined;

function Patch({ id, path }: { id: string; path: string }) {
  const diff = useStore(changesStore, (state) => diffOf(state, id, path));
  useEffect(() => {
    if (!diff) changesStore.getState().readDiff(id, path);
  }, [diff, id, path]);
  if (!diff || diff.state === "reading") return <p className="thread-field-quiet">Reading…</p>;
  if (diff.state === "not read")
    return (
      <p className="panel-empty" data-quiet="not-read">
        {`⌀ Not read. ${diff.reason}`}
      </p>
    );
  return (
    <pre className="thread-diff" data-diff={path}>
      {diff.patch
        .replace(/\n$/u, "")
        .split("\n")
        .map((line, index) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: a patch's lines are fixed once read.
            key={index}
            data-line={kind(line)}
          >
            {line || " "}
          </span>
        ))}
      {diff.truncated && <span data-line="cut">The rest of this diff is too large to show.</span>}
    </pre>
  );
}

/** Each changed file against the commit the thread's branch was cut from, a unified diff when opened. */
function Changes({ id, summary }: ThreadTabProps) {
  const changes = useChanges(id);
  useReadWhileShown(id);
  const [open, setOpen] = useState<string | null>(null);
  const landsIn = summary?.thread.landsIn;
  const base =
    landsIn && landsIn.target !== "asking"
      ? landsIn.baseRef.replace(/^refs\/(?:remotes\/(?:origin|upstream)\/|heads\/)?/u, "")
      : undefined;
  const refresh = () => changesStore.getState().refresh(id);
  let body: ReactNode;
  if (!changes || changes.state === "reading")
    body = <p className="thread-field-quiet">Reading the worktree…</p>;
  else if (changes.state === "asking")
    body = (
      <p className="panel-empty" data-quiet="asking">
        ⌀ An Asking thread has no worktree, so nothing has changed.
      </p>
    );
  else if (changes.state === "not read")
    body = (
      <p className="panel-empty" data-quiet="not-read">
        {`⌀ The worktree was not read. ${changes.reason}`}
      </p>
    );
  else if (changes.files.length === 0)
    body = (
      <p className="panel-empty" data-quiet="none">
        ⌀ No changes yet.
      </p>
    );
  else
    body = (
      <ul className="thread-changes" aria-label="Changed files">
        {changes.files.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              className="thread-change"
              aria-expanded={open === file.path}
              onClick={() => setOpen(open === file.path ? null : file.path)}
            >
              <span className="thread-change-path">{file.path}</span>
              <span className="thread-change-counts">{counts(file)}</span>
            </button>
            {open === file.path && <Patch id={id} path={file.path} />}
          </li>
        ))}
      </ul>
    );
  return (
    <section className="thread-changes-tab" aria-label="Changes">
      <div className="thread-changes-head">
        <h3>{base ? `Changes against ${base}` : "Changes"}</h3>
        <button
          type="button"
          onClick={refresh}
          disabled={changes?.state === "reading" || changes?.state === "asking"}
        >
          Refresh
        </button>
      </div>
      {body}
    </section>
  );
}

export const CHANGES_TAB: ThreadTab = { id: "changes", label: "Changes", Panel: Changes };
