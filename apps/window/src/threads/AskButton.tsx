// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useStore } from "zustand";
import { isReachable, useRegistry } from "../app/routes.js";
import { Icon } from "../components/icons/Icon.js";
import { watchStore } from "../store/watch.js";
import { canStartIn, scopeLabel } from "./scopes.js";
import { askIn } from "./start.js";
import { NEW_THREAD } from "./store.js";
import "./threads.css";

/** Ask at the end of a service's, Template's or Environment's top bar: a draft scoped there. */
export function AskButton({ scope }: { scope: string }) {
  const registry = useRegistry();
  const tree = useStore(watchStore, (watch) => watch.snapshot?.body.tree);
  if (!isReachable({ kind: "thread", id: NEW_THREAD }, registry)) return null;
  if (!canStartIn(scope, tree)) return null;
  const name = `Ask Copilot about ${scopeLabel(scope)}`;
  return (
    <button
      type="button"
      className="ask-in"
      aria-label={name}
      title={name}
      onClick={() => askIn(scope)}
    >
      <Icon name="messageCircle" size={15} />
    </button>
  );
}
