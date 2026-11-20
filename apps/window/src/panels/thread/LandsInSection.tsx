// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ThreadSummary } from "../../threads/store.js";
import type { ThreadSection } from "./section.js";
import { PROGRAM, type ThreadTabProps } from "./tab.js";
import { useChanges } from "./useChanges.js";

type Landing = NonNullable<ThreadSummary["thread"]["landsIn"]>;

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

/** Where a change goes: the base the branch was cut from and what it opens. */
function destination(landsIn: Exclude<Landing, { target: "asking" }>): string {
  if (landsIn.target !== "request")
    return {
      "fork-main": "Fork · main · a GitHub pull request",
      "fork-integration": "Fork · fork_integration · a pull request into fork_integration",
      upstream: "Upstream · a GitLab merge request",
    }[landsIn.target];
  const kind = landsIn.forge === "github" ? "Pull request" : "Merge request";
  return `${kind} #${landsIn.requestNumber} · ${landsIn.sourceBranch}`;
}

function LandsIn({ id, summary }: ThreadTabProps) {
  const landsIn = summary?.thread.landsIn;
  const changes = useChanges(id);
  if (!summary) return <span data-quiet="not-known">⌀ Not known</span>;
  if (!landsIn || landsIn.target === "asking")
    return (
      <span>
        {summary.thread.scope === PROGRAM
          ? "Asking. A program thread changes no code. A change continues in a service, the template or the environment."
          : "Asking. Reads the shared clone. No branch, nothing to push."}
      </span>
    );
  const counted =
    changes?.state === "read"
      ? ` · ${plural(changes.ahead, "commit")} · ${plural(changes.files.length, "file")} changed`
      : "";
  return (
    <>
      <span>{destination(landsIn)}</span>
      <span className="thread-field-quiet">{`${landsIn.branch}${counted}`}</span>
      <span className="thread-field-quiet">
        {"Base "}
        <code>{landsIn.baseRef.replace(/^refs\/(?:remotes\/)?/u, "")}</code>
        {" at "}
        <code>{landsIn.head.slice(0, 7)}</code>
      </span>
    </>
  );
}

export const LANDS_IN_SECTION: ThreadSection = {
  id: "lands-in",
  label: "Lands in",
  Field: LandsIn,
};
