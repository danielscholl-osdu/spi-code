// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import briefing from "../../../../../fixtures/rib-59d6895/oracle/briefing.json?raw";
import releases from "../../../../../fixtures/rib-59d6895/oracle/releases.json?raw";
import { DEFAULT_REGISTRY, navigate } from "../../app/routes.js";
import { Shell } from "../../app/Shell.js";
import { selectionStore } from "../../panels/selection.js";
import { testSnapshot } from "../../store/test-snapshot.js";
import { watchStore } from "../../store/watch.js";
import Horizon from "../horizon/index.js";
import Repositories from "../repositories/index.js";
import { type Lens, lensSortStore } from "./table.js";

const recorded = () => testSnapshot(briefing, releases);
const send = vi.fn();
let previous: Window["spi"];
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;

beforeEach(() => {
  previous = window.spi;
  window.spi = {
    proof: false,
    postMessage: send,
    openExternal: vi.fn(),
    onMessage: () => () => {},
  };
  send.mockClear();
  lensSortStore.setState({ repositories: null, horizon: null });
  selectionStore.getState().clear();
  selectionStore.getState().setTab("detail");
  watchStore.setState({ snapshot: { cursor: 1, body: recorded() }, setup: null });
  window.location.hash = "#inbox";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  selectionStore.getState().clear();
  watchStore.setState({ snapshot: null });
  window.spi = previous;
});

async function mount(lens: Lens, body = recorded()) {
  watchStore.setState({ snapshot: { cursor: 1, body } });
  await act(async () => {
    navigate({ kind: "today" });
    renderLens(lens);
  });
}

function need<E extends HTMLElement = HTMLElement>(
  selector: string,
  scope: ParentNode = container,
): E {
  const element = scope.querySelector<E>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}

const table = () => need("main table");
const rows = () => [...table().querySelectorAll<HTMLTableRowElement>("tr[data-selection-id]")];
const ids = () => rows().map((row) => row.dataset.selectionId);
const click = (element: HTMLElement) => act(async () => element.click());
function renderLens(lens: Lens) {
  const views = { repositories: Repositories, horizon: Horizon };
  const View = views[lens];
  root.render(
    <Shell
      registry={{
        ...DEFAULT_REGISTRY,
        views: { ...DEFAULT_REGISTRY.views, today: () => <View key={lens} /> },
      }}
    />,
  );
}
const go = (lens: Lens) => act(async () => renderLens(lens));

async function sort(label: string) {
  const header = [...table().querySelectorAll("th[scope=col]")].find((header) =>
    header.querySelector("button")?.textContent?.startsWith(label),
  );
  if (!header) throw new Error(`Missing ${label} sort`);
  await click(need("button", header));
}

it("renders each recorded Horizon row with its original title, kind, sub and when", async () => {
  const body = recorded();
  await mount("horizon", body);
  expect(ids()).toEqual(body.briefing.themes.map((theme) => theme.inspect ?? `theme:${theme.id}`));
  for (const [index, theme] of body.briefing.themes.entries()) {
    expect(
      [...(rows()[index]?.querySelectorAll("td") ?? [])].map((cell) => cell.textContent),
    ).toEqual([`${theme.title}${theme.sub}`, theme.kind.toUpperCase(), theme.when]);
  }
  expect(container.querySelector("main [data-theme-detail]")).toBeNull();
});

it("keeps Program before Forks when a fork leads the repository data", async () => {
  const body = recorded();
  const repositories = body.briefing.repositories;
  const program = repositories.rows.filter((row) => row.group === "program");
  const forks = repositories.rows.filter((row) => row.group === "fork");
  repositories.rows = [...forks, ...program];
  await mount("repositories", body);
  expect([...table().querySelectorAll(".lens-group th")].map((cell) => cell.textContent)).toEqual([
    "Program",
    "Forks",
  ]);
  expect(ids()).toEqual([...program, ...forks].map((row) => row.id));
  for (const [index, row] of repositories.rows.entries())
    expect(need(`tr[data-selection-id="${row.id}"]`).dataset.pointer).toBe(
      `/briefing/repositories/rows/${index}`,
    );
});

it.each(["repositories", "horizon"] as const)(
  "toggles every %s column's sort, preserving repository groups",
  async (lens) => {
    await mount(lens);
    const sourceOrder = ids();
    const headers = [...table().querySelectorAll<HTMLButtonElement>("thead th button")];
    for (const header of headers) {
      const label = header.textContent ?? "";
      const index = headers.indexOf(header);
      const original = rows().map((row) => ({
        id: row.dataset.selectionId,
        group: row.parentElement?.dataset.group,
        // A theme's sub is displayed with its name, not as a sort key.
        value:
          index === 0 && lens === "horizon"
            ? (recorded().briefing.themes.find(
                (theme) => (theme.inspect ?? `theme:${theme.id}`) === row.dataset.selectionId,
              )?.title ?? "")
            : (row.cells[index]?.textContent ?? ""),
      }));
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
      for (const descending of [false, true]) {
        await click(header);
        expect(header.parentElement?.getAttribute("aria-sort"), label).toBe(
          descending ? "descending" : "ascending",
        );
        const expected = [...new Set(original.map((row) => row.group))].flatMap((group) =>
          original
            .filter((row) => row.group === group)
            .sort(
              (a, b) =>
                collator.compare(a.value, b.value) * (descending ? -1 : 1) ||
                sourceOrder.indexOf(a.id) - sourceOrder.indexOf(b.id),
            )
            .map((row) => row.id),
        );
        expect(ids(), label).toEqual(expected);
      }
    }
  },
);

it("keeps a separate sort per retired view after unmounting", async () => {
  await mount("repositories");
  await sort("Repository");
  const repositories = ids();
  await go("horizon");
  await sort("Theme");
  await sort("Theme");
  const horizon = ids();
  for (const [lens, expected, direction] of [
    ["repositories", repositories, "ascending"],
    ["horizon", horizon, "descending"],
  ] as const) {
    await go(lens);
    expect(ids()).toEqual(expected);
    expect(table().querySelector("thead th")?.getAttribute("aria-sort")).toBe(direction);
  }
});

it.each(["repositories", "horizon"] as const)(
  "leaves lone dot cells blank in %s without stripping real separators",
  async (lens) => {
    const body = recorded();
    const repo = body.briefing.repositories.rows[0];
    const theme = body.briefing.themes[0];
    if (!repo || !theme) throw new Error("Missing recorded rows");
    repo.cells.changes.text = "·";
    repo.cells.changes.rest = "·";
    repo.title = "·";
    theme.when = "·";
    await mount(lens, body);
    const blankLabels = lens === "repositories" ? ["Pull Requests", "Needs"] : ["When"];
    for (const label of blankLabels)
      expect(rows()[0]?.querySelector(`[data-column="${label}"]`)?.textContent).toBe("");
    expect(
      rows()
        .flatMap((row) => [...row.cells])
        .some((cell) => cell.textContent === "·"),
    ).toBe(false);
    if (lens === "repositories")
      expect(rows()[0]?.querySelector('[data-column="Issues"]')?.textContent).toBe("0 · 7");
  },
);

it.each(["repositories", "horizon"] as const)(
  "selects a %s row through the shared inspect path into the right panel",
  async (lens) => {
    await mount(lens);
    const row = rows()[0];
    if (!row?.dataset.selectionId) throw new Error("Missing lens row");
    await click(row);
    const id = row.dataset.selectionId;
    expect(selectionStore.getState().selected).toBe(id);
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "inspect.request",
        payload: { id },
      }),
    );
    await act(async () =>
      selectionStore.getState().receive({
        version: PROTOCOL_VERSION,
        id: selectionStore.getState().request,
        kind: "response",
        type: "inspect.result",
        payload: {
          id,
          class: "READY",
          cause: "Recorded row inspected",
          effect: "Current",
          next: "Read the selection",
          why: "",
          evidence: [],
          related: [],
          actions: [],
          approval: null,
        },
      }),
    );
    expect(need("aside .detail-title").textContent).toBe(selectionStore.getState().row?.title);
    expect(need('aside [data-field="cause"]').textContent).toBe("Recorded row inspected");
    expect(container.querySelectorAll('aside[aria-label="Detail"]')).toHaveLength(1);
    expect(container.querySelector("main .inspector")).toBeNull();
  },
);

it.each([
  ["repo:osdu-spi", "#engineering-system"],
  ["repo:osdu-spi-stack", "#environment"],
  ["repo:legal", "#service/legal"],
])("opens %s on its thing and retains the repository selection", async (id, hash) => {
  await mount("repositories");
  await click(need(`tr[data-selection-id="${id}"] .lens-name`));
  expect(window.location.hash).toBe(hash);
  expect(selectionStore.getState().selected).toBe(id);
  expect(need("aside .detail-title").textContent).toBe(
    recorded().briefing.repositories.rows.find((row) => row.id === id)?.title,
  );
});

it("opens a named Horizon fork while retaining a theme-only selection", async () => {
  const body = recorded();
  const theme = body.briefing.themes.find(({ id }) => id === "deadline:azure-removal");
  if (!theme || theme.inspect) throw new Error("Missing theme-only fixture");
  theme.sub = "partition keeps its Azure provider";
  await mount("horizon", body);
  const id = `theme:${theme.id}`;
  const row = need(`tr[data-selection-id="${id}"]`);
  const fork = need<HTMLButtonElement>(".lens-link", row);
  await click(fork);
  expect(window.location.hash).toBe("#service/partition");
  expect(selectionStore.getState().selected).toBe(id);
  expect(need("aside .detail-title").textContent).toBe(theme.title);
});

it("uses the displayed sort order for keyboard selection", async () => {
  await mount("horizon");
  await sort("Theme");
  const ordered = rows();
  const first = ordered[0];
  if (!first) throw new Error("Missing sorted row");
  first.focus();
  await act(async () =>
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
  );
  expect(selectionStore.getState().selected).toBe(ordered[1]?.dataset.selectionId);
  expect(document.activeElement).toBe(ordered[1]);
});
