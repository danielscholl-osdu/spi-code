// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ThreadWireEvent } from "@spi-code/contracts";
import { useStore } from "zustand";
import { treeServices } from "../app/queue.js";
import { watchStore } from "../store/watch.js";
import { openScopePicker } from "./picker.js";
import { PLACE_SCOPES, scopeLabel } from "./scopes.js";
import { askIn } from "./start.js";
import type { AskTarget, ThreadSummary } from "./store.js";
import "./continue.css";

/** The text of the last turn that completed, as the host packs it into the finding. */
export function finishedAnswer(events: readonly ThreadWireEvent[]): string {
  const last = [...events]
    .reverse()
    .find((event) => event.type === "turn.finished" && event.outcome === "completed");
  if (last?.type !== "turn.finished") return "";
  return events
    .flatMap((event) =>
      event.type === "assistant.delta" && event.turnId === last.turnId ? [event.text] : [],
    )
    .join("")
    .trim();
}

const escaped = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** The scopes an answer names, first named first: forks by id, Template and Environment by name. */
export function scopesNamed(text: string, services: readonly string[]): string[] {
  return [
    ...services.map((id) => ({ id, word: id })),
    ...PLACE_SCOPES.map(({ id, label }) => ({ id, word: label })),
  ]
    .map(({ id, word }) => ({
      id,
      at: text.search(new RegExp(`(?<![\\w/-])${escaped(word)}(?![\\w-])`, "u")),
    }))
    .filter(({ at }) => at >= 0)
    .sort((a, b) => a.at - b.at)
    .map(({ id }) => id);
}

/** A program answer's way on: a child thread in a scope it names, carrying it as the finding. */
export function ContinueIn({
  thread,
  events,
}: {
  thread: ThreadSummary;
  events: readonly ThreadWireEvent[];
}) {
  const tree = useStore(watchStore, (watch) => watch.snapshot?.body.tree);
  const answer = finishedAnswer(events);
  if (!answer) return null;
  const finding: AskTarget = {
    subject: `finding:${thread.id}`,
    label: `Finding · ${thread.thread.title ?? "Untitled thread"}`,
    parent: thread.id,
  };
  return (
    <div className="thread-continue" data-continue-from={thread.id}>
      <span className="thread-continue-lead">Continue in</span>
      {scopesNamed(answer, treeServices(tree)).map((scope) => (
        <button key={scope} type="button" onClick={() => askIn(scope, finding)}>
          {scopeLabel(scope)} ›
        </button>
      ))}
      <button type="button" onClick={() => openScopePicker({ mode: "new", target: finding })}>
        Another scope…
      </button>
    </div>
  );
}
