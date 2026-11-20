// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useState } from "react";
import { useStore } from "zustand";
import { type CommitResult, changesStore } from "./changes-store.js";
import type { ThreadSection } from "./section.js";
import type { ThreadTabProps } from "./tab.js";
import { useChanges } from "./useChanges.js";

function outcomeLine(commit: CommitResult): string {
  if (commit.outcome === "committed") return `Committed ${commit.head.slice(0, 7)}.`;
  if (commit.outcome === "failed") return `The commit failed. ${commit.reason}`;
  if (commit.outcome === "not known")
    return `Whether the commit ran is not known. ${commit.reason} The changes were read again.`;
  return commit.reason;
}

/** Why Commit is disabled, or undefined when it can run. */
function blocked(changes: ReturnType<typeof useChanges>): string | undefined {
  if (!changes || changes.state === "reading") return "Reading the worktree…";
  if (changes.state === "asking") return "An Asking thread has nothing to commit.";
  if (changes.state === "not read")
    return "The worktree was not read, so there is nothing to commit.";
  return changes.uncommitted ? undefined : "Nothing to commit.";
}

/** A message and Commit, run by the host's git confined to the worktree; never by Copilot. */
function Commit({ id }: ThreadTabProps) {
  const changes = useChanges(id);
  const commit = useStore(changesStore, (state) => state.commits[id]);
  const [message, setMessage] = useState("");
  const committing = commit?.outcome === "committing";
  const reason = blocked(changes);
  if (changes?.state === "asking") return <span data-quiet="asking">{reason}</span>;
  return (
    <form
      className="thread-commit"
      onSubmit={(event) => {
        event.preventDefault();
        if (reason || committing || !message.trim()) return;
        changesStore.getState().commit(id, message);
        setMessage("");
      }}
    >
      <textarea
        aria-label="Commit message"
        placeholder="Commit message"
        rows={2}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
      />
      <div className="thread-commit-row">
        <button type="submit" disabled={Boolean(reason) || committing || !message.trim()}>
          {committing ? "Committing…" : "Commit"}
        </button>
        {reason && <span className="thread-field-quiet">{reason}</span>}
      </div>
      {commit && !committing && (
        <p className="thread-commit-outcome" data-outcome={commit.outcome} role="status">
          {outcomeLine(commit)}
        </p>
      )}
    </form>
  );
}

export const COMMIT_SECTION: ThreadSection = { id: "git", label: "Git", Field: Commit };
