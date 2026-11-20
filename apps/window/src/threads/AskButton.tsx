// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useStore } from "zustand";
import { treeServices } from "../app/queue.js";
import { isReachable, useRegistry } from "../app/routes.js";
import { Icon } from "../components/icons/Icon.js";
import { watchStore } from "../store/watch.js";
import { askIn } from "./start.js";
import { NEW_THREAD } from "./store.js";
import "./threads.css";

/** Ask at the end of a service's top bar: a draft already scoped there. */
export function AskButton({ scope }: { scope: string }) {
  const registry = useRegistry();
  const tree = useStore(watchStore, (watch) => watch.snapshot?.body.tree);
  if (!isReachable({ kind: "thread", id: NEW_THREAD }, registry)) return null;
  if (!treeServices(tree).includes(scope)) return null;
  const name = `Ask Copilot about ${scope}`;
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
