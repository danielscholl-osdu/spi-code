// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Briefing, ViewSnapshotSchema } from "@spi-code/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import recorded from "../../../../../fixtures/watch/snapshot-59d6895.json?raw";
import { Shell } from "../../app/Shell.js";
import { selectionStore } from "../../panels/selection.js";
import { createWatchStore, watchStore } from "../../store/watch.js";
import Template from "./index.js";

const body = ViewSnapshotSchema.parse(JSON.parse(recorded));
const previous = watchStore.getState();
const previousSpi = window.spi;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.location.hash = "";
  window.spi = {
    proof: false,
    openExternal: vi.fn(async () => true),
    postMessage: vi.fn(),
    onMessage: () => () => {},
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  selectionStore.getState().clear();
  watchStore.setState(previous);
  window.spi = previousSpi;
  window.location.hash = "";
});

function storeWith(briefing: Briefing = body.briefing) {
  const store = createWatchStore(vi.fn());
  store.setState({ snapshot: { cursor: body.cursor, body: { ...body, briefing } } });
  return store;
}

async function render(node: ReactNode) {
  await act(async () => root.render(node));
}

const part = (name: string) => container.querySelector(`[data-part="${name}"]`);
const parts = () =>
  [...container.querySelectorAll("[data-part]")].map((element) =>
    element.getAttribute("data-part"),
  );

it("draws the template fact, the rollout, the repository and Threads in that order", async () => {
  await render(<Template store={storeWith()} />);
  expect(container.querySelector("h1")?.textContent).toBe("Template");
  expect(parts()).toEqual(["fact", "rollout", "repository", "threads"]);
  const fact = part("fact")?.querySelector(".inbox-fact");
  expect(fact?.getAttribute("data-pointer")).toBe("/briefing/facts/2");
  expect(
    [".inbox-fact-label", ".inbox-fact-figure", ".inbox-fact-sub"].map(
      (selector) => fact?.querySelector(selector)?.textContent,
    ),
  ).toEqual([
    "Template · main bb49a03",
    "0 of 5",
    "on main · 4 changes reach the forks · 5 of 5 on v1.2.0",
  ]);
  const repository = part("repository");
  expect(repository?.querySelector(".template-repo-title")?.textContent).toBe(
    "High code-scanning alert: Branch-Protection",
  );
  expect(
    [...(repository?.querySelectorAll(".template-repo-section h3") ?? [])].map(
      (heading) => heading.textContent,
    ),
  ).toEqual(["Issues 7", "Code scanning 7 ours · 0 upstream"]);
  expect(repository?.querySelectorAll(".template-lines li")).toHaveLength(6);
  expect(repository?.querySelector(".template-note")?.textContent).toBe(
    "Not shown here: 4 more alert groups; 1 pipeline PR, on Flow. The inspector lists every item.",
  );
});

it("draws the rollout as the Inbox's queue row with its detail lines", async () => {
  await render(<Template store={storeWith()} />);
  const rollout = part("rollout");
  const row = rollout?.querySelector('.inbox-row[data-selection-id="rollout"]');
  expect(row?.getAttribute("data-pointer")).toBe("/briefing/focus/2");
  expect(row?.querySelector(".inbox-priority")?.textContent).toBe("P1");
  expect(row?.querySelector(".inbox-row-title")?.textContent).toBe("Rollout to template bb49a03");
  expect(row?.querySelector(".inbox-sub")?.textContent).toBe("0 of 5 merged · 0 of 5 lanes busy");
  expect(
    [...(rollout?.querySelectorAll(".template-detail > div") ?? [])].map((line) => [
      line.querySelector("dt")?.textContent,
      line.querySelector("dd")?.textContent,
    ]),
  ).toEqual([
    ["Plan", "1 wave · lanes 5 from rollout.json"],
    [
      "Watch",
      "Upstream sync at 10-22 00:00 opens 1 PR (entitlements halts instead) that share these lanes.",
    ],
    [
      "Reaches",
      "build/Dockerfile · java-build action · setup-maven action · build.yml · cascade.yml · copilot-setup-steps.yml · acceptance-image action · validate.yml · build/acceptance.Dockerfile",
    ],
  ]);
});

it("selects the rollout row and a repository line into the right panel", async () => {
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  window.location.hash = "#template";
  await render(<Shell />);
  const title = () => container.querySelector("aside .detail-title")?.textContent;
  const requested = () =>
    vi.mocked(window.spi.postMessage).mock.calls.map(([message]) => message.payload);

  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-part="rollout"] .inbox-row-title')?.click(),
  );
  expect(selectionStore.getState()).toMatchObject({
    selected: "rollout",
    row: { id: "rollout", kind: "queue", title: "Rollout to template bb49a03" },
  });
  expect(requested()).toEqual([{ id: "rollout" }]);
  expect(title()).toBe("Rollout to template bb49a03");
  expect(
    container.querySelector('[data-part="rollout"] .inbox-row')?.hasAttribute("data-selected"),
  ).toBe(true);

  const line = container.querySelector<HTMLElement>(
    '[data-part="repository"] [data-selection-id="issue:Azure/osdu-spi:245"]',
  );
  await act(async () => line?.click());
  expect(selectionStore.getState()).toMatchObject({
    selected: "issue:Azure/osdu-spi:245",
    row: {
      kind: "repository",
      title: "Template sync skips file removal when the template tip is unchanged · #245",
      prefixes: ["/briefing/repositories/rows/0/sections/0/lines/1"],
    },
  });
  expect(requested()).toEqual([{ id: "rollout" }, { id: "issue:Azure/osdu-spi:245" }]);
  expect(title()).toBe(
    "Template sync skips file removal when the template tip is unchanged · #245",
  );
  expect(line?.getAttribute("aria-selected")).toBe("true");

  await act(async () =>
    container.querySelector<HTMLElement>('[data-part="repository"] .template-repo-lead')?.click(),
  );
  expect(selectionStore.getState().row).toMatchObject({ id: "repo:osdu-spi", kind: "repository" });
});

it("says threads are not available yet", async () => {
  await render(<Template store={storeWith()} />);
  expect(part("threads")?.textContent).toBe("ThreadsThreads are not available yet.");
});

it("leaves out the parts the snapshot does not carry", async () => {
  const [repository] = body.briefing.repositories.rows;
  if (!repository) throw new Error("fixture has no repository");
  const unnamed = {
    ...repository,
    sections: [
      {
        title: "Issues",
        count: "1",
        lines: [{ tag: "bug", tone: "neutral" as const, text: "No id", sub: "opened 1d ago" }],
      },
    ],
  };
  await render(
    <Template
      store={storeWith({
        ...body.briefing,
        facts: body.briefing.facts.filter(({ label }) => !label.startsWith("Template")),
        focus: body.briefing.focus.map((item) =>
          item.id === "rollout" ? { ...item, more: undefined } : item,
        ),
        repositories: { ...body.briefing.repositories, rows: [unnamed] },
      })}
    />,
  );
  expect(parts()).toEqual(["rollout", "repository", "threads"]);
  expect(container.querySelector(".template-detail")).toBeNull();
  const line = container.querySelector(".template-lines li");
  expect(line?.textContent).toBe("bugNo idopened 1d ago");
  expect(line?.hasAttribute("data-selection-id")).toBe(false);

  await render(
    <Template
      store={storeWith({
        ...body.briefing,
        focus: body.briefing.focus.filter(({ id }) => id !== "rollout"),
        rest: [],
        repositories: {
          ...body.briefing.repositories,
          rows: body.briefing.repositories.rows.filter(({ name }) => name !== "osdu-spi"),
        },
      })}
    />,
  );
  expect(parts()).toEqual(["fact", "threads"]);
});
