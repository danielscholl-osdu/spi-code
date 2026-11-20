// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { navigate, type Route } from "../app/navigation.js";
import { type AskTarget, NEW_THREAD, threadStore } from "./store.js";

/** ⌘N and New thread: the open service's scope, else Program, with the open row as its chip. */
export function newThread(route: Route) {
  const { target, startDraft } = threadStore.getState();
  startDraft(route.kind === "service" ? route.id : null, target);
  navigate({ kind: "thread", id: NEW_THREAD });
}

/** Ask about this: a draft in the row's fork with the row as its one chip. Nothing is sent. */
export function askAbout(target: AskTarget & { scope: string }) {
  threadStore.getState().startDraft(target.scope, target);
  navigate({ kind: "thread", id: NEW_THREAD });
}
