// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Link } from "@spi-code/contracts";
import { useEffect, useRef, useState } from "react";
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

function blocked(changes: ReturnType<typeof useChanges>, publishing: boolean): string | undefined {
  if (publishing) return "Publishing…";
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
  const lastHead = useRef<{ id: string; head: string }>({ id, head: "" });
  const head = changes?.state === "read" ? changes.head : "";
  const githubConfirmation =
    publication?.state === "ready" ? publication.githubConfirmation : undefined;
  const confirmKey = githubConfirmation
    ? `${id}\0${githubConfirmation.kind}\0${githubConfirmation.value}`
    : "";
  const [typed, setTyped] = useState({ key: "", value: "" });
  const confirmation = typed.key === confirmKey ? typed.value : "";
  useEffect(() => {
    if (!publication) publicationStore.getState().read(id);
  }, [id, publication]);
  useEffect(() => {
    const previous = lastHead.current;
    if (previous.id !== id) {
      lastHead.current = { id, head };
      return;
    }
    if (head && previous.head && head !== previous.head) {
      publicationStore.getState().read(id);
    }
    if (head) lastHead.current = { id, head };
  }, [id, head]);
  useEffect(() => {
    if (outcome?.outcome === "pushed" || outcome?.outcome === "published") {
      setTyped({ key: "", value: "" });
    }
  }, [outcome]);
  const reason = blocked(changes, publishing);
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
  const observedHead = publication.observedHead;
  const needsConfirmation = Boolean(githubConfirmation) && !confirmation.trim();
  return (
    <div className="thread-publish">
      <span className="thread-field-quiet">
        Commit <code>{head ? head.slice(0, 7) : "not read"}</code> · {publication.branch} · Remote{" "}
        <code>
          {observedHead === null ? "new branch" : (observedHead?.slice(0, 7) ?? "not read")}
        </code>
      </span>
      {githubConfirmation && (
        <div className="thread-publish-confirm" data-github-confirm={githubConfirmation.kind}>
          <label htmlFor={`github-confirm-${id}`}>
            {githubConfirmation.kind === "request"
              ? `This push changes .github/. Type request number ${githubConfirmation.value} to confirm.`
              : `This push changes .github/. New requests have no number yet; type target branch ${githubConfirmation.value} to confirm.`}
          </label>
          <input
            id={`github-confirm-${id}`}
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder={githubConfirmation.value}
            value={confirmation}
            onChange={(event) => setTyped({ key: confirmKey, value: event.target.value })}
          />
        </div>
      )}
      <div className="thread-commit-row">
        <button
          type="button"
          disabled={Boolean(reason) || !head || observedHead === undefined || needsConfirmation}
          onClick={() => {
            if (observedHead !== undefined)
              publicationStore
                .getState()
                .publish(
                  id,
                  head,
                  observedHead,
                  githubConfirmation ? confirmation.trim() : undefined,
                );
          }}
        >
          {publication.opens === "none"
            ? "Push"
            : publication.opens === "pull-request"
              ? "Push / Open draft PR"
              : "Push / Open draft MR"}
        </button>
        {reason && <span className="thread-field-quiet">{reason}</span>}
        {outcome?.outcome === "refused" && /remote branch/u.test(outcome.reason) && (
          <button type="button" onClick={() => publicationStore.getState().read(id)}>
            Update
          </button>
        )}
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
