// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { type ThreadSummary, threadStore } from "../../threads/store.js";
import { LINEAGE_SECTION } from "./LineageSection.js";

const initial = threadStore.getState();
const thread = (id: string, definition: ThreadSummary["thread"]): ThreadSummary => ({
  id,
  thread: definition,
  status: "Open",
  sequence: 1,
  updatedAt: 1,
  settledAt: null,
  done: false,
});
const parent = thread("p1", { scope: "program", title: "Forks on 8.4" });
const child = thread("c1", { scope: "legal", title: "Bump legal", parent: "p1" });
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  threadStore.setState(initial, true);
});

async function lineage(of: ThreadSummary, listed: readonly ThreadSummary[] | null) {
  threadStore.setState({ threads: listed });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const { Field } = LINEAGE_SECTION;
  await act(async () => root.render(<Field id={of.id} summary={of} />));
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return [...container.children].map((element) => ({
    text: element.textContent,
    href: element.getAttribute("href"),
  }));
}

it("links a child to the thread it continues, and the parent to the threads that continue it", async () => {
  expect(await lineage(child, [parent, child])).toEqual([
    { text: "Continues Forks on 8.4 · Program", href: "#thread/p1" },
  ]);
  await cleanup?.();
  expect(await lineage(parent, [parent, child])).toEqual([
    { text: "Continued in Bump legal · legal", href: "#thread/c1" },
  ]);
});

it("says not known for a parent the host no longer lists, or before it lists threads", async () => {
  expect(await lineage(child, [child])).toEqual([
    { text: "⌀ Continues a thread the host no longer lists.", href: null },
  ]);
  await cleanup?.();
  expect(await lineage(child, null)).toEqual([{ text: "⌀ Not known", href: null }]);
});
