// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Link } from "@spi-code/contracts";
import { useEffect } from "react";
import { useStore } from "zustand";
import { LinkPill } from "../../components/kit/LinkPill.js";
import { publicationStore } from "./publication-store.js";
import type { ThreadSection } from "./section.js";
import type { ThreadTabProps } from "./tab.js";
import { useChanges } from "./useChanges.js";

function link(
  request: Extract<
    ReturnType<typeof publicationStore.getState>["outcomes"][string],
    { outcome: "published" }
  >["request"],
): Link {
  return {
    kind: request.forge === "github" ? "pr" : "mr",
    label:
      request.forge === "github" ? `PR #${request.requestNumber}` : `MR !${request.requestNumber}`,
    url: request.url,
  };
}

function outcomeText(outcome: ReturnType<typeof publicationStore.getState>["outcomes"][string]) {
  if (outcome.outcome === "published")
    return `Opened draft ${outcome.request.forge === "github" ? "PR" : "MR"} ${outcome.request.requestNumber}.`;
  if (outcome.outcome === "pushed") return `Pushed ${outcome.head.slice(0, 7)}.`;
  if (outcome.outcome === "publishing") return "Publishing…";
  return outcome.reason;
}

function blocked(
  changes: ReturnType<typeof useChanges>,
  outcome: ReturnType<typeof publicationStore.getState>["outcomes"][string] | undefined,
  publishing: boolean,
): string | undefined {
  if (publishing) return "Publishing…";
  if (outcome?.outcome === "not known") return "Read the forge before trying again.";
  if (!changes || changes.state === "reading") return "Reading the worktree…";
  if (changes.state === "asking") return "An Asking thread has nothing to push.";
  if (changes.state === "not read") return "The worktree was not read, so nothing can be pushed.";
  if (changes.uncommitted) return "Commit the worktree before pushing.";
  return changes.ahead > 0 ? undefined : "There is no commit to push.";
}

function Publication({ id }: ThreadTabProps) {
  const changes = useChanges(id);
  const publication = useStore(publicationStore, (state) => state.publications[id]);
  const outcome = useStore(publicationStore, (state) => state.outcomes[id]);
  const publishing = outcome?.outcome === "publishing";
  useEffect(() => {
    if (!publication) publicationStore.getState().read(id);
  }, [id, publication]);
  const reason = blocked(changes, outcome, publishing);
  if (publication?.state === "asking")
    return <span data-quiet="asking">An Asking thread has nothing to push.</span>;
  if (!publication || publication.state === "reading")
    return <span className="thread-field-quiet">Reading the destination…</span>;
  if (publication.state === "not read")
    return <span data-quiet="not-read">⌀ Not read. {publication.reason}</span>;
  if (publication.state === "unavailable")
    return (
      <span data-quiet="unavailable">
        {publication.reason}{" "}
        {publication.url && (
          <a
            href={publication.url}
            onClick={(event) => {
              event.preventDefault();
              void window.spi?.openExternal(publication.url ?? "");
            }}
          >
            Open upstream ↗
          </a>
        )}
      </span>
    );
  const head = changes?.state === "read" ? changes.head : "";
  return (
    <div className="thread-publish">
      <span className="thread-field-quiet">
        Commit <code>{head ? head.slice(0, 7) : "not read"}</code> · {publication.branch}
      </span>
      <div className="thread-commit-row">
        <button
          type="button"
          disabled={Boolean(reason) || !head}
          onClick={() => publicationStore.getState().publish(id, head)}
        >
          {publication.opens === "none"
            ? "Push"
            : publication.opens === "pull-request"
              ? "Push / Open draft PR"
              : "Push / Open draft MR"}
        </button>
        {reason && <span className="thread-field-quiet">{reason}</span>}
      </div>
      {outcome?.outcome !== "publishing" && outcome && (
        <p className="thread-publish-outcome" data-outcome={outcome.outcome} role="status">
          {outcomeText(outcome)}
          {outcome.outcome === "published" && <LinkPill link={link(outcome.request)} filled />}
        </p>
      )}
    </div>
  );
}

export const PUBLICATION_SECTION: ThreadSection = {
  id: "publish",
  label: "Push / Open request",
  Field: Publication,
};
