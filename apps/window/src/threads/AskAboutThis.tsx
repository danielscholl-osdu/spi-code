// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useStore } from "zustand";
import { navigate } from "../app/navigation.js";
import { treeServices } from "../app/queue.js";
import { useRegistry } from "../app/routes.js";
import { watchStore } from "../store/watch.js";
import { askAbout } from "./start.js";
import { type AskTarget, type ThreadSummary, threadStore } from "./store.js";

type Ask = { target: AskTarget & { scope?: string }; owner?: ThreadSummary };

/** Whether a row offers Ask about this: a thread that owns it, or a fork to scope a new one to. */
export function useAskAbout(target: AskTarget | null): Ask | null {
  const owner = useStore(threadStore, (state) =>
    target ? state.threads?.find((thread) => thread.thread.subject === target.subject) : undefined,
  );
  const tree = useStore(watchStore, (state) => state.snapshot?.body.tree);
  const threads = useRegistry().views.thread;
  if (!target || !threads) return null;
  if (owner) return { target, owner };
  return target.scope && treeServices(tree).includes(target.scope) ? { target } : null;
}

/**
 * The one Copilot control on a row or popover. A row a thread owns opens that thread; a row with no
 * fork has none yet (spicode-xia.39).
 */
export function AskAboutThis({ ask: { target, owner } }: { ask: Ask }) {
  const { scope } = target;
  return (
    <button
      type="button"
      className={owner ? "ask-about ask-about--owned" : "ask-about"}
      data-keeps-popover
      onClick={() =>
        owner ? navigate({ kind: "thread", id: owner.id }) : scope && askAbout({ ...target, scope })
      }
    >
      <span className="ask-about-mark" aria-hidden="true">
        ✦
      </span>
      {owner ? `${owner.thread.title ?? "Untitled thread"} · ${owner.status}` : "Ask about this"}
    </button>
  );
}
