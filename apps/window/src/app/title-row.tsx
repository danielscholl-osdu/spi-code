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

/** A view's title with its chips, and what it puts at the row's end. */
export type TitleParts = { title: ReactNode; end?: ReactNode };

/** The titles the mounted views declare; the most recently mounted one is shown. */
export type TitleStore = {
  set(owner: symbol, parts: TitleParts): void;
  remove(owner: symbol): void;
  subscribe(listener: () => void): () => void;
  current(): TitleParts | undefined;
};

export function createTitleStore(): TitleStore {
  const titles = new Map<symbol, TitleParts>();
  const listeners = new Set<() => void>();
  let shown: TitleParts | undefined;
  const publish = () => {
    shown = [...titles.values()].at(-1);
    for (const listener of listeners) listener();
  };
  return {
    set(owner, parts) {
      titles.set(owner, parts);
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
 * A view's title and chips, and what it puts at the row's end. Inside the shell they are handed to
 * the shell's title row; outside it the view keeps its own header.
 */
export function PaneTitle({ children, end }: { children: ReactNode; end?: ReactNode }) {
  const store = useContext(TitleContext);
  const [owner] = useState(() => Symbol("title"));
  useLayoutEffect(() => {
    store?.set(owner, { title: children, end });
  });
  useLayoutEffect(() => () => store?.remove(owner), [store, owner]);
  if (store) return null;
  return (
    <header className="place-header pane-header">
      {children}
      {end}
    </header>
  );
}

function useTitle(store: TitleStore) {
  return useSyncExternalStore(store.subscribe, store.current, store.current);
}

/** What the shell's title row shows: the mounted view's title, else the route's name alone. */
export function TitleRow({ store, fallback }: { store: TitleStore; fallback: string }) {
  return useTitle(store)?.title ?? <h1 data-place>{fallback}</h1>;
}

/** What the mounted view puts at the end of the centre's part of the top row. */
export function TitleEnd({ store }: { store: TitleStore }) {
  return useTitle(store)?.end ?? null;
}
