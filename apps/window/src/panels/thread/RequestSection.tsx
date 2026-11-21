// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useStore } from "zustand";
import { LinkPill } from "../../components/kit/LinkPill.js";
import { watchStore } from "../../store/watch.js";
import { requestInSweep } from "../../threads/request-ownership.js";
import type { ThreadSection } from "./section.js";
import type { ThreadTabProps } from "./tab.js";

function Request({ summary }: ThreadTabProps) {
  const snapshot = useStore(watchStore, (state) => state.snapshot);
  const request = summary?.thread.request;
  if (!request) return <span data-quiet="none">None yet.</span>;
  const owned = requestInSweep(snapshot?.body, request.url);
  const kind = request.forge === "github" ? "pr" : "mr";
  const label =
    request.forge === "github" ? `PR #${request.requestNumber}` : `MR !${request.requestNumber}`;
  return (
    <div className="thread-request">
      <LinkPill link={{ kind, label, url: request.url }} filled />
      <span className="thread-field-quiet">
        {owned ? "Owned by this thread" : "Pending until the next sweep reads it"}
      </span>
    </div>
  );
}

export const REQUEST_SECTION: ThreadSection = {
  id: "request",
  label: "Request",
  Field: Request,
};
