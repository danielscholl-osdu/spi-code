// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { navigate, parseRoute, type Route, routeLabel } from "../app/navigation.js";
import { openScopePicker } from "./picker.js";
import { scopeOfRoute } from "./scopes.js";
import { type AskTarget, type DraftFrom, NEW_THREAD, threadStore } from "./store.js";

const isDraftRoute = (route: Route | undefined) =>
  route?.kind === "thread" && route.id === NEW_THREAD;

/** Where a new draft's back link returns to: the page it was opened from, kept from draft to draft. */
function from(): DraftFrom | undefined {
  const route = parseRoute(window.location.hash);
  const { draft, threads } = threadStore.getState();
  if (!route || isDraftRoute(route)) return draft?.from;
  if (route.kind === "thread") {
    const title = threads?.find((thread) => thread.id === route.id)?.thread.title;
    return { label: title ?? "Thread", route };
  }
  return { label: routeLabel(route), route };
}

/** ⌘N and the compose icon: the scope picker over the page. Inside a draft it moves that draft. */
export function newThread() {
  const { draft } = threadStore.getState();
  if (draft && isDraftRoute(parseRoute(window.location.hash)))
    openScopePicker({ mode: "change", current: draft.scope });
  else openScopePicker({ mode: "new" });
}

/** A draft in one scope, cursor in its text box, carrying a row as its chip when given one. */
export function askIn(
  scope: string,
  target?: AskTarget | null,
  options?: string | { landsIn?: "fork-main" | "upstream"; text?: string },
) {
  const text = typeof options === "string" ? options : options?.text;
  const landsIn = typeof options === "string" ? undefined : options?.landsIn;
  threadStore.getState().startDraft(scope, target ?? null, from(), text, landsIn);
  navigate({ kind: "thread", id: NEW_THREAD });
}

/** Ask Copilot in Find: a draft holding the sentence, scoped to the page and carrying the open row. */
export function askFromFind(text: string) {
  askIn(scopeOfRoute(parseRoute(window.location.hash)), threadStore.getState().target, text);
}

/** Ask about this: a draft in the row's fork with the row as its one chip. Nothing is sent. */
export function askAbout(target: AskTarget & { scope: string }) {
  askIn(target.scope, target);
}
