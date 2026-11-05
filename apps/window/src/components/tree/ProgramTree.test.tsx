// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION, TreeStatusSchema } from "@spi-code/contracts";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { routes } from "../../app/routes.js";
import { createWatchStore } from "../../store/watch.js";
import { ProgramTree } from "./ProgramTree.js";

const states = ["fresh", "stale", "incomplete", "failed", "unread"] as const;
const ids = [
  "today",
  "system",
  "template",
  "repositories",
  "releases",
  "stack",
  "environment",
  "services",
  "flow",
  "horizon",
  "service:legal",
  "service:storage",
  "service:schema",
  "service:partition",
  "service:file",
  "service:entitlements",
  "threads",
  "runs",
  "run:123",
  "run:789",
  "setup",
];
const tree = TreeStatusSchema.parse(
  ids.map((id, index) => ({ id, status: states[index % states.length] })),
);
const snapshot = {
  cursor: 1,
  tree,
  briefing: {
    focus: [
      {
        evidence: [
          { label: "Upgrade", url: "https://github.com/Azure/stack/actions/runs/123" },
          { label: "Duplicate", url: "https://github.com/Azure/stack/actions/runs/123" },
          { label: "Not a run", url: "https://github.com/Azure/stack/pull/456" },
        ],
      },
    ],
  },
};

function Harness({ store }: { store: ReturnType<typeof createWatchStore> }) {
  const [route, setRoute] = useState<(typeof routes)[number]>(routes[0]);
  return (
    <>
      <ProgramTree store={store} route={route} onNavigate={setRoute} />
      <h1>{route.label}</h1>
    </>
  );
}

async function mount(body: unknown = snapshot) {
  const store = createWatchStore(vi.fn());
  const receive = (payload: unknown) =>
    store.getState().receive({
      version: PROTOCOL_VERSION,
      id: "snapshot",
      kind: "event",
      type: "view.snapshot",
      payload,
    });
  if (body) receive(body);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Harness store={store} />));
  return {
    container,
    receive,
    async dispose() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("renders every program entry and the exact snapshot status, with service overflow", async () => {
  const view = await mount();
  try {
    for (const { id, status } of tree) {
      const dot = view.container.querySelector(`[data-selection-id="${id}"] [role="img"]`);
      expect(dot?.getAttribute("data-status"), id).toBe(status);
      expect(dot?.getAttribute("aria-label"), id).toBe(status);
    }
    for (const label of [
      "Today",
      "System",
      "Template",
      "Repositories",
      "Releases",
      "Stack",
      "Shared environment",
      "Services",
      "Flow",
      "Horizon",
      "Threads",
      "Runs",
      "Setup",
    ]) {
      expect(view.container.textContent).toContain(label);
    }
    const overflow = view.container.querySelector<HTMLDetailsElement>(".service-overflow");
    expect(overflow?.open).toBe(false);
    expect(overflow?.querySelector("summary")?.textContent).toBe("+1 more");
    expect(overflow?.textContent).toContain("entitlements");
    await act(async () => overflow?.querySelector("summary")?.click());
    expect(overflow?.open).toBe(true);
    expect(view.container.textContent).toContain("No threads yet");
    expect(view.container.textContent).toContain("No app runs yet");
    expect(view.container.querySelectorAll('a[href*="/actions/runs/"]')).toHaveLength(1);
    expect(view.container.textContent).toContain("Upgrade · #123");
    expect(view.container.textContent).toContain("GitHub run #789");
  } finally {
    await view.dispose();
  }
});

it("navigates through existing routes and retains the selected service in Flow", async () => {
  const view = await mount();
  try {
    for (const route of routes) {
      const button = view.container.querySelector<HTMLButtonElement>(
        `[data-selection-id="${route.id}"]`,
      );
      await act(async () => button?.click());
      expect(view.container.querySelector("h1")?.textContent).toBe(route.label);
      expect(button?.getAttribute("aria-current")).toBe("page");
    }
    for (const id of ["template", "service:legal", "service:entitlements"]) {
      const entry = view.container.querySelector<HTMLAnchorElement>(`[data-selection-id="${id}"]`);
      await act(async () => entry?.click());
      expect(view.container.querySelector("h1")?.textContent).toBe("Flow");
      expect(entry?.getAttribute("aria-current")).toBe("page");
      expect(view.container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    }
    await act(async () =>
      view.container.querySelector<HTMLAnchorElement>('[data-selection-id="run:789"]')?.click(),
    );
    expect(view.container.querySelector("h1")?.textContent).toBe("Environment");
  } finally {
    await view.dispose();
  }
});

it("shows unread before the first sweep, updates from the store, and rejects invalid tree data visibly", async () => {
  const view = await mount(null);
  try {
    expect(view.container.textContent).toContain("No GitHub workflow runs");
    expect(
      view.container
        .querySelector('[data-selection-id="today"] [role="img"]')
        ?.getAttribute("data-status"),
    ).toBe("unread");
    await act(async () => view.receive(snapshot));
    await act(async () => view.receive({ ...snapshot, cursor: 0, tree: [] }));
    expect(
      view.container
        .querySelector('[data-selection-id="today"] [role="img"]')
        ?.getAttribute("data-status"),
    ).toBe("fresh");
    await act(async () => view.receive({ cursor: 2, tree: [{ id: "today", status: "green" }] }));
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Invalid program tree",
    );
  } finally {
    await view.dispose();
  }
});
