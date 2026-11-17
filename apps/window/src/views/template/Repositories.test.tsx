// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type Repositories,
  type ViewSnapshot,
  ViewSnapshotSchema,
  type WatchItem,
} from "@spi-code/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import { openSelection, setOpenSelection } from "../../app/navigation.js";
import { createSelectionStore } from "../../panels/selection.js";
import { createWatchStore } from "../../store/watch.js";
import { fixtureLoader, installSpi } from "../../test-utils/harness.js";
import Template from "./index.js";

const loadFixture = fixtureLoader(readFixture);
const sweep1116: { repositories: Repositories; items: WatchItem[] } = JSON.parse(
  readFileSync(resolve("apps/window/src/views/template/repositories-1116.json"), "utf8"),
);
const opened1116 = JSON.parse(
  readFileSync(resolve("apps/window/src/components/opened-body/sweep-1116.json"), "utf8"),
) as { lines: NonNullable<ViewSnapshot["briefing"]["lines"]> };
const previousZone = process.env.TZ;
process.env.TZ = "America/Chicago";
afterAll(() => {
  if (previousZone === undefined) delete process.env.TZ;
  else process.env.TZ = previousZone;
});
let harness: ReturnType<typeof installSpi>;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-11-17T09:00:00Z"));
  setOpenSelection(null);
  harness = installSpi({ openExternal: async () => true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  harness.restore();
  vi.useRealTimers();
});

/** The Nov 6 snapshot carrying the 16 Nov sweep's repositories and items; its provenance needs as many focus items. */
function snapshot1116(): ViewSnapshot {
  const body = structuredClone(loadFixture("snapshot-1106.json"));
  body.briefing.lines?.push(
    ...structuredClone(opened1116.lines.filter(({ id }) => id === "blocked:halt:crs-conversion")),
  );
  body.briefing.repositories = structuredClone(sweep1116.repositories);
  const items = structuredClone(sweep1116.items);
  const kept = body.briefing.focus.length;
  body.briefing.focus = items.slice(0, kept);
  body.briefing.rest = items.slice(kept);
  return ViewSnapshotSchema.parse(body);
}

async function mount(body: ViewSnapshot) {
  const selection = createSelectionStore({ postMessage: vi.fn() });
  const store = createWatchStore(vi.fn(), selection);
  store.setState({ snapshot: { cursor: body.cursor, body } });
  await act(async () => root.render(<Template store={store} />));
  return selection;
}

const row = (name: string) => {
  const found = container.querySelector<HTMLElement>(`.repos-row[data-repo="${name}"]`);
  if (!found) throw new Error(`No repository row ${name}`);
  return found;
};
const expand = async (name: string) => act(async () => row(name).querySelector("button")?.click());
const line = (id: string) => container.querySelector<HTMLElement>(`[data-line="${id}"]`);

it("expands crs-conversion to issue #44 on Today and leaves storage's #67 off it", async () => {
  await mount(snapshot1116());
  expect(row("crs-conversion").textContent).toContain("on Today");
  expect(row("storage").textContent).not.toContain("on Today");

  await expand("crs-conversion");
  const halt = line("issue:Azure/osdu-spi-crs-conversion:44");
  expect(halt?.dataset.onToday).toBe("halt:crs-conversion");
  expect(halt?.querySelector(".repos-on-today")?.textContent).toBe(
    "On Today · Sync halted on schemathesis-tests",
  );
  expect(line("issue:Azure/osdu-spi-crs-conversion:37")?.dataset.onToday).toBeUndefined();

  await expand("storage");
  expect(line("issue:Azure/osdu-spi-crs-conversion:44")).toBeNull();
  const codeowners = line("issue:Azure/osdu-spi-storage:67");
  expect(codeowners).not.toBeNull();
  expect(codeowners?.dataset.onToday).toBeUndefined();
  expect(codeowners?.querySelector(".repos-on-today")).toBeNull();
});

it("marks the lines core resolved: sources #44 and #72, companions such as search #78", async () => {
  await mount(snapshot1116());
  for (const name of ["search", "workflow", "unit", "crs-catalog", "crs-conversion", "indexer"])
    expect(row(name).textContent).toContain("on Today");
  await expand("crs-conversion");
  expect(line("issue:Azure/osdu-spi-crs-conversion:44")?.dataset.onToday).toBe(
    "halt:crs-conversion",
  );
  expect(line("issue:Azure/osdu-spi-crs-conversion:42")?.dataset.onToday).toBe(
    "gate1:crs-conversion",
  );
  await expand("indexer");
  expect(line("issue:Azure/osdu-spi-indexer:72")?.dataset.onToday).toBe("sync-run:indexer");
  expect(line("issue:Azure/osdu-spi-indexer:63")?.dataset.onToday).toBeUndefined();
  await expand("search");
  expect(line("issue:Azure/osdu-spi-search:65")?.dataset.onToday).toBeUndefined();
  const companion = line("issue:Azure/osdu-spi-search:78");
  expect(companion?.dataset.onToday).toBe("gate1:search");
  expect(companion?.querySelector(".repos-on-today")?.textContent).toMatch(/^On Today · /);
});

it("claims no empty repository when partition counts an issue it does not list", async () => {
  await mount(snapshot1116());
  expect(row("partition").textContent).toContain("0 · 1");
  await expand("partition");
  const expanded = container.querySelector(".repos-expanded")?.textContent ?? "";
  expect(expanded).not.toMatch(/no open/i);
});

const dialog = () => container.querySelector<HTMLElement>('[role="dialog"]');
const clickLine = (id: string) =>
  act(async () => line(id)?.querySelector<HTMLButtonElement>(".repos-line-text")?.click());

it("opens #44 as its Today member and returns to that member from the popover", async () => {
  await mount(snapshot1116());
  await expand("crs-conversion");
  await clickLine("issue:Azure/osdu-spi-crs-conversion:44");
  expect(dialog()?.dataset.selection).toBe(
    "rline~crs-conversion|issue:Azure/osdu-spi-crs-conversion:44",
  );
  expect(dialog()?.querySelector('[data-kind="issue"]')?.getAttribute("href")).toBe(
    "https://github.com/Azure/osdu-spi-crs-conversion/issues/44",
  );
  expect(dialog()?.querySelector('[href="#today"]')).not.toBeNull();
  await act(async () => dialog()?.querySelector<HTMLAnchorElement>('[href="#today"]')?.click());
  expect(window.location.hash).toBe("#today");
  expect(openSelection()).toEqual({ kind: "item", id: "halt:crs-conversion" });
  expect(dialog()).toBeNull();
});

it("opens storage #67 with its counted Can wait disposition and source", async () => {
  const body = snapshot1116();
  const url = "https://github.com/Azure/osdu-spi-storage/issues/67";
  if (!body.briefing.today) throw new Error("Missing Today summary");
  body.briefing.today.canWait = [
    {
      id: "repositories",
      label: "Repositories",
      place: "engineering",
      notRead: [],
      counts: [
        {
          kind: "issue",
          label: "human-required",
          count: 1,
          tone: "neutral",
          names: ["storage"],
          urls: [url],
        },
      ],
    },
  ];
  await mount(body);
  await expand("storage");
  await clickLine("issue:Azure/osdu-spi-storage:67");
  expect(dialog()?.textContent).toContain("Not on Today. Counted under Can wait.");
  expect(dialog()?.querySelector('[href="#today"]')).toBeNull();
  await act(async () => dialog()?.querySelector<HTMLAnchorElement>('[data-kind="issue"]')?.click());
  expect(harness.spi.openExternal).toHaveBeenCalledWith(url);
});

it("does not infer Today or Can wait membership from a matching source URL", async () => {
  const body = snapshot1116();
  const entry = body.briefing.repositories.rows
    .find(({ name }) => name === "crs-conversion")
    ?.sections.flatMap(({ lines }) => lines)
    .find(({ id }) => id === "issue:Azure/osdu-spi-crs-conversion:44");
  if (!entry) throw new Error("Missing #44");
  delete entry.onToday;
  if (body.briefing.today) body.briefing.today.canWait = [];
  await mount(body);
  await expand("crs-conversion");
  await clickLine(entry.id ?? "");
  expect(dialog()?.querySelector('[href="#today"]')).toBeNull();
  expect(dialog()?.textContent).toContain("Not on Today.");
  expect(dialog()?.textContent).not.toContain("Counted under Can wait");
});

it("reopens a repository line from its place selection and refreshes its body on a sweep", async () => {
  const body = snapshot1116();
  setOpenSelection({ kind: "rline", id: "storage|issue:Azure/osdu-spi-storage:67" });
  const selection = createSelectionStore({ postMessage: vi.fn() });
  const store = createWatchStore(vi.fn(), selection);
  store.setState({ snapshot: { cursor: body.cursor, body } });
  await act(async () => root.render(<Template store={store} />));
  expect(dialog()).not.toBeNull();
  const entry = body.briefing.repositories.rows
    .find(({ name }) => name === "storage")
    ?.sections.flatMap(({ lines }) => lines)
    .find(({ id }) => id === "issue:Azure/osdu-spi-storage:67");
  if (!entry) throw new Error("Missing #67");
  entry.text = "Updated CODEOWNERS issue · #67";
  await act(async () =>
    store.setState({ snapshot: { cursor: body.cursor + 1, body: { ...body } } }),
  );
  expect(dialog()?.querySelector("h3")?.textContent).toBe(entry.text);
});
