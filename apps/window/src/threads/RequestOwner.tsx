// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useStore } from "zustand";
import { navigate } from "../app/navigation.js";
import { threadOwningRequest } from "./request-ownership.js";
import { threadStore } from "./store.js";
import "./request-owner.css";

export function RequestOwner({ url, compact = false }: { url: string; compact?: boolean }) {
  const owner = useStore(threadStore, (state) =>
    threadOwningRequest(state.threads, undefined, [url]),
  );
  if (!owner) return null;
  return (
    <button
      type="button"
      className="request-owner"
      data-state="owned"
      data-request={url}
      title={`${owner.thread.title ?? "Untitled thread"} owns this request`}
      onClick={() => navigate({ kind: "thread", id: owner.id })}
    >
      ✦ {compact ? "Owned" : `${owner.thread.title ?? "Untitled thread"} · owned`}
    </button>
  );
}
