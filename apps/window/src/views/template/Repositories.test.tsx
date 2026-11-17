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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import { createSelectionStore } from "../../panels/selection.js";
import { createWatchStore } from "../../store/watch.js";
import { fixtureLoader, installSpi } from "../../test-utils/harness.js";
import Template from "./index.js";

const loadFixture = fixtureLoader(readFixture);
const sweep1116: { repositories: Repositories; items: WatchItem[] } = JSON.parse(
  readFileSync(resolve("apps/window/src/views/template/repositories-1116.json"), "utf8"),
);
let harness: ReturnType<typeof installSpi>;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  harness = installSpi({ openExternal: async () => true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  harness.restore();
});

/** The Nov 6 snapshot carrying the 16 Nov sweep's repositories and items; its provenance needs as many focus items. */
function snapshot1116(): ViewSnapshot {
  const body = structuredClone(loadFixture("snapshot-1106.json"));
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
  await act(async () => root.render(<Template store={store} inspector={selection} />));
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
