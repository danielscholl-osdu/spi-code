// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";

/** The titles the mounted views declare; the most recently mounted one is shown. */
export type TitleStore = {
  set(owner: symbol, title: ReactNode): void;
  remove(owner: symbol): void;
  subscribe(listener: () => void): () => void;
  current(): ReactNode | undefined;
};

export function createTitleStore(): TitleStore {
  const titles = new Map<symbol, ReactNode>();
  const listeners = new Set<() => void>();
  let shown: ReactNode | undefined;
  const publish = () => {
    shown = [...titles.values()].at(-1);
    for (const listener of listeners) listener();
  };
  return {
    set(owner, title) {
      titles.set(owner, title);
      publish();
    },
    remove(owner) {
      if (titles.delete(owner)) publish();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    current: () => shown,
  };
}

const TitleContext = createContext<TitleStore | null>(null);

export const TitleProvider = TitleContext.Provider;

/**
 * A view's title, its chips and Pin. Inside the shell they are handed to the shell's title row;
 * outside it the view keeps its own header.
 */
export function PaneTitle({ children }: { children: ReactNode }) {
  const store = useContext(TitleContext);
  const [owner] = useState(() => Symbol("title"));
  useLayoutEffect(() => {
    store?.set(owner, children);
  });
  useLayoutEffect(() => () => store?.remove(owner), [store, owner]);
  if (store) return null;
  return <header className="place-header pane-header">{children}</header>;
}

/** What the shell's title row shows: the mounted view's title, else the route's name alone. */
export function TitleRow({ store, fallback }: { store: TitleStore; fallback: string }) {
  const title = useSyncExternalStore(store.subscribe, store.current, store.current);
  return title ?? <h1 data-place>{fallback}</h1>;
}
