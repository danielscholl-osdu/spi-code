// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import briefing from "../../../../../fixtures/rib-59d6895/oracle/briefing.json?raw";
import releases from "../../../../../fixtures/rib-59d6895/oracle/releases.json?raw";
import { type Lens, navigate } from "../../app/routes.js";
import { Shell } from "../../app/Shell.js";
import { selectionStore } from "../../panels/selection.js";
import { testSnapshot } from "../../store/test-snapshot.js";
import { watchStore } from "../../store/watch.js";
import { lensSortStore } from "./table.js";

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
  lensSortStore.setState({ flow: null, repositories: null, horizon: null });
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
    navigate({ kind: "lens", lens });
    root.render(<Shell />);
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
const go = (lens: Lens) => act(async () => navigate({ kind: "lens", lens }));

async function sort(label: string) {
  const header = [...table().querySelectorAll("th[scope=col]")].find((header) =>
    header.querySelector("button")?.textContent?.startsWith(label),
  );
  if (!header) throw new Error(`Missing ${label} sort`);
  await click(need("button", header));
}

it("renders every recorded Flow row in the design's columns, not a local pane or station fleet", async () => {
  const body = recorded();
  await mount("flow", body);
  expect([...table().querySelectorAll("thead th")].map((cell) => cell.textContent)).toEqual([
    "Fork",
    "Plan",
    "Behind",
    "Carries",
    "Ready",
    "Sync PR",
    "Cascade",
    "Sync to main",
    "Main run",
    "Next",
  ]);
  expect(ids()).toEqual(body.briefing.flow.rows.map((row) => row.inspect));
  for (const [index, row] of body.briefing.flow.rows.entries()) {
    const cells = [...(rows()[index]?.querySelectorAll("td") ?? [])].map(
      (cell) => cell.textContent,
    );
    expect(cells).toEqual([
      `${row.fork}${row.tag}`,
      row.plan.text,
      row.behind,
      row.carries,
      row.ready.text,
      ...row.line.map((cell) => (cell.text === "·" ? "" : cell.text)),
      row.next.text,
    ]);
  }
  expect(container.querySelector("main [data-up-detail]")).toBeNull();
  expect(container.querySelector("main .service-stations")).toBeNull();
});

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

it.each(["flow", "repositories", "horizon"] as const)(
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
        // A Flow fork's tag and a theme's sub are displayed with their names, not sort keys.
        value:
          index === 0
            ? lens === "flow"
              ? (row.dataset.selectionId?.replace(/^upstream:/, "") ?? "")
              : lens === "horizon"
                ? (recorded().briefing.themes.find(
                    (theme) => (theme.inspect ?? `theme:${theme.id}`) === row.dataset.selectionId,
                  )?.title ?? "")
                : (row.cells[index]?.textContent ?? "")
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

it("keeps a separate sort per lens after unmounting through real navigation", async () => {
  await mount("flow");
  await sort("Fork");
  await sort("Fork");
  const flow = ids();
  await go("repositories");
  await sort("Repository");
  const repositories = ids();
  await go("horizon");
  await sort("Theme");
  await sort("Theme");
  const horizon = ids();
  for (const [lens, expected, direction] of [
    ["flow", flow, "descending"],
    ["repositories", repositories, "ascending"],
    ["horizon", horizon, "descending"],
  ] as const) {
    await go(lens);
    expect(ids()).toEqual(expected);
    expect(table().querySelector("thead th")?.getAttribute("aria-sort")).toBe(direction);
  }
});

it("sorts Behind numerically rather than putting ten before two", async () => {
  const body = recorded();
  const first = body.briefing.flow.rows[0];
  if (!first) throw new Error("Missing Flow fixture");
  first.behind = "10";
  await mount("flow", body);
  await sort("Behind");
  expect(rows().map((row) => row.querySelector('[data-column="Behind"]')?.textContent)).toEqual([
    "0",
    "0",
    "0",
    "2",
    "10",
  ]);
});

it.each(["flow", "repositories", "horizon"] as const)(
  "leaves lone dot cells blank in %s without stripping real separators",
  async (lens) => {
    const body = recorded();
    const flow = body.briefing.flow.rows[0];
    const repo = body.briefing.repositories.rows[0];
    const theme = body.briefing.themes[0];
    if (!flow || !repo || !theme) throw new Error("Missing recorded rows");
    flow.plan.text = "·";
    flow.carries = "·";
    flow.ready.text = "·";
    flow.next.text = "·";
    repo.cells.changes.text = "·";
    repo.cells.changes.rest = "·";
    repo.title = "·";
    theme.when = "·";
    await mount(lens, body);
    const blankLabels =
      lens === "flow"
        ? ["Plan", "Carries", "Ready", "Next"]
        : lens === "repositories"
          ? ["Pull Requests", "Needs"]
          : ["When"];
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

it.each(["flow", "repositories", "horizon"] as const)(
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

it.each(["name", "Enter", "double-click"] as const)(
  "opens a Flow row by %s with its selection still in Detail",
  async (method) => {
    const flow = recorded().briefing.flow.rows[0];
    if (!flow) throw new Error("Missing Flow fixture");
    await mount("flow");
    const row = rows()[0];
    if (!row) throw new Error("Missing Flow row");
    if (method === "name") await click(need("button.lens-name", row));
    else
      await act(async () =>
        row.dispatchEvent(
          method === "Enter"
            ? new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
            : new MouseEvent("dblclick", { bubbles: true }),
        ),
      );
    expect(window.location.hash).toBe(`#service/${flow.fork}`);
    expect(selectionStore.getState().selected).toBe(flow.inspect);
    expect(need("aside .detail-title").textContent).toBe(flow.detail.title);
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
  await mount("flow");
  await sort("Fork");
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

it.each(["planning", "flight", "quiet"] as const)(
  "shows next, also and the schedule under the %s table; Plan selects its title, lines and note",
  async (mode) => {
    const body = recorded();
    const view = body.briefing.flow;
    view.mode = mode;
    view.next.text = "Start the prepared forks";
    view.next.quiet = mode === "quiet";
    view.also = [
      { text: "Wait for the pilot", inspect: "upstream:legal" },
      { text: "Read the rollout" },
    ];
    await mount("flow", body);
    const next = need('main [data-pointer="/briefing/flow/next"]');
    expect(next.textContent).toContain(view.next.title);
    expect(next.textContent).toContain(view.next.text);
    expect(need("button", next).classList.contains("lens-quiet")).toBe(view.next.quiet);
    const also = need('main [aria-label="Also waiting"]');
    for (const item of view.also) expect(also.textContent).toContain(item.text);
    const schedule = need('main [data-pointer="/briefing/flow/schedule"]');
    expect(schedule.textContent).toBe(`${view.schedule?.title}${view.schedule?.text}`);
    expect(table().compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(next.compareDocumentPosition(also) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(also.compareDocumentPosition(schedule) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector("main")?.textContent).not.toContain(view.plan.note);
    await click(need("main .lens-toolbar button"));
    expect(selectionStore.getState().selected).toBe(view.inspect);
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "inspect.request",
        payload: { id: view.inspect },
      }),
    );
    const detail = need("aside");
    expect(need(".detail-title", detail).textContent).toBe(view.plan.title);
    for (const line of view.plan.lines) {
      expect(detail.textContent).toContain(line.label);
      expect(detail.textContent).toContain(line.text);
    }
    expect(detail.textContent).toContain(view.plan.note);
    await click(need("button", also));
    expect(selectionStore.getState().selected).toBe("upstream:legal");
  },
);
