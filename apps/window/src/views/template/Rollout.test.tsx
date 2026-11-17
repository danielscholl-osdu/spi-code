// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type FocusItem,
  type Since,
  type ViewSnapshot,
  ViewSnapshotSchema,
} from "@spi-code/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import { openSelection, setOpenSelection } from "../../app/navigation.js";
import { createSelectionStore } from "../../panels/selection.js";
import { createWatchStore } from "../../store/watch.js";
import { fixtureLoader, installSpi } from "../../test-utils/harness.js";
import Template from "./index.js";

const loadFixture = fixtureLoader(readFixture);
type Engineering = NonNullable<ViewSnapshot["briefing"]["places"]>[number];
const sweep1116: { visual: Engineering["visual"]; since: Since; item: Partial<FocusItem> } =
  JSON.parse(readFileSync(resolve("apps/window/src/views/template/rollout-1116.json"), "utf8"));
const opened1116 = JSON.parse(
  readFileSync(resolve("apps/window/src/components/opened-body/sweep-1116.json"), "utf8"),
) as { lines: NonNullable<ViewSnapshot["briefing"]["lines"]> };
let harness: ReturnType<typeof installSpi>;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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
});

/** The Nov 6 snapshot carrying core's rollout fields from the 16 Nov sweep behind the mock. */
function snapshot1116(): ViewSnapshot {
  const body = structuredClone(loadFixture("snapshot-1106.json"));
  const engineering = body.briefing.places?.find(({ place }) => place === "engineering");
  if (!engineering) throw new Error("No engineering place in snapshot-1106.json");
  engineering.visual = structuredClone(sweep1116.visual);
  body.briefing.since = structuredClone(sweep1116.since);
  body.briefing.lines = body.briefing.lines?.map((line) =>
    structuredClone(
      opened1116.lines.find((next) => next.id === line.id && next.id === "waiting:rollout") ?? line,
    ),
  );
  const replace = (items: typeof body.briefing.focus) =>
    items.map((item) =>
      item.id === "rollout" ? { ...item, ...structuredClone(sweep1116.item) } : item,
    );
  body.briefing.focus = replace(body.briefing.focus);
  body.briefing.rest = replace(body.briefing.rest);
  return ViewSnapshotSchema.parse(body);
}

async function mount(body: ViewSnapshot) {
  const selection = createSelectionStore({ postMessage: vi.fn() });
  const store = createWatchStore(vi.fn(), selection);
  store.setState({ snapshot: { cursor: body.cursor, body } });
  await act(async () => root.render(<Template store={store} />));
  return selection;
}

const rungs = () =>
  [...container.querySelectorAll<HTMLElement>(".rollout-rung")].map((rung) => ({
    service: rung.querySelector("b")?.textContent,
    stage: rung.dataset.stage,
    member: rung.dataset.member !== undefined,
  }));
const services = (stage: string) =>
  rungs()
    .filter((rung) => rung.stage === stage)
    .map(({ service }) => service);
const key = () => [...container.querySelectorAll(".rollout-key li")].map((li) => li.textContent);

it("ladders the 16 Nov rollout: 1 verified, 5 merged pending verification, 7 to dispatch with the dot", async () => {
  await mount(snapshot1116());
  expect(container.querySelector(".rollout-title")?.textContent).toBe(
    "Rollout of osdu-spi commit 1a4730d ↗",
  );
  expect(rungs()).toHaveLength(13);
  expect(services("verified")).toEqual(["file"]);
  expect(services("pending")).toEqual(["partition", "entitlements", "legal", "schema", "storage"]);
  const todo = [
    "indexer",
    "search",
    "workflow",
    "indexer-queue",
    "unit",
    "crs-catalog",
    "crs-conversion",
  ];
  expect(services("todo")).toEqual(todo);
  expect(
    rungs()
      .filter(({ member }) => member)
      .map(({ service }) => service),
  ).toEqual(todo);
  expect(key()).toEqual([
    "1 verified",
    "5 merged · verification pending",
    "7 to dispatch",
    "0 failed",
    "0 not read",
  ]);
  expect(container.querySelector(".rollout-member")?.textContent).toBe(
    "on Today: the 7 forks the template hasn't reached",
  );
});

it("shows not read, never merged, for an occupied fork whose Sync Template result was not read", async () => {
  const unread = snapshot1116();
  const row = unread.briefing.since?.rows.find(({ workflow }) => workflow === "template");
  const partition = row?.slots.find(({ service }) => service === "partition");
  if (!partition) throw new Error("No partition slot in the template row");
  partition.state = "unknown";
  await mount(unread);
  expect(services("unread")).toEqual(["partition"]);
  expect(services("pending")).toEqual(["entitlements", "legal", "schema", "storage"]);

  const noSince = snapshot1116();
  delete noSince.briefing.since;
  await mount(noSince);
  expect(services("pending")).toEqual([]);
  expect(services("unread")).toEqual(["partition", "entitlements", "legal", "schema", "storage"]);
  expect(services("verified")).toEqual(["file"]);
});

it("draws no member dot when the dispatch is not the operator's move", async () => {
  const body = snapshot1116();
  for (const item of [...body.briefing.focus, ...body.briefing.rest])
    if (item.id === "rollout") delete item.actor;
  await mount(body);
  expect(services("todo")).toHaveLength(7);
  expect(rungs().some(({ member }) => member)).toBe(false);
  expect(container.querySelector(".rollout-member")).toBeNull();
});

const clickRung = async (service: string) => {
  const button = container.querySelector<HTMLButtonElement>(`[data-rung="${service}"]`);
  if (!button) throw new Error(`Missing rung ${service}`);
  await act(async () => button.click());
  return button;
};
const dialog = () => container.querySelector<HTMLElement>('[role="dialog"]');

it("opens indexer's dispatch member with its deadline, all seven forks and template change", async () => {
  await mount(snapshot1116());
  const button = await clickRung("indexer");
  expect(dialog()?.querySelector("time")?.dateTime).toBe("2026-11-17T08:00:00.000Z");
  expect(dialog()?.textContent).toContain(
    "To 7 forks: indexer, search, workflow, indexer-queue, unit, crs-catalog, crs-conversion.",
  );
  expect(dialog()?.querySelector('[data-kind="compare"]')?.getAttribute("href")).toContain(
    `/compare/`,
  );
  expect(dialog()?.querySelectorAll("button")).toHaveLength(1);
  expect(openSelection()).toEqual({ kind: "rung", id: "indexer" });
  expect(document.activeElement).toBe(dialog());
  await act(async () =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })),
  );
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(button);
});

it("opens a merged partition rung with the read result, pending verification and its latest template run", async () => {
  const body = snapshot1116();
  const runs = body.services?.find(({ service }) => service === "partition")?.runs;
  if (!runs) throw new Error("No partition runs");
  const source = "https://github.com/Azure/osdu-spi-partition/actions/runs/123456";
  runs.push({
    id: "run:template-new",
    workflow: "Sync Template",
    result: "success",
    time: "2026-11-16T23:00:00Z",
    url: source,
  });
  runs.push({
    id: "run:template-old",
    workflow: "Sync Template",
    result: "failure",
    time: "2026-11-15T23:00:00Z",
    url: `${source}0`,
  });
  await mount(body);
  await clickRung("partition");
  expect(dialog()?.textContent).toContain("partition has merged v1.4.0 +94.");
  expect(dialog()?.textContent).toContain(
    "Verification of the new template on main has not been read as green yet.",
  );
  expect(dialog()?.querySelector('[data-kind="run"]')?.getAttribute("href")).toBe(source);
  expect(dialog()?.querySelector('[data-kind="compare"]')).not.toBeNull();
  expect(dialog()?.querySelector(".opened-body-place")).toBeNull();
  await act(async () => dialog()?.querySelector<HTMLAnchorElement>('[data-kind="run"]')?.click());
  expect(harness.spi.openExternal).toHaveBeenCalledWith(source);
});

it("opens a verified rung without claiming unread merges or inventing a run", async () => {
  const body = snapshot1116();
  delete body.briefing.since;
  const file = body.services?.find(({ service }) => service === "file");
  if (file) file.runs = [];
  await mount(body);
  await clickRung("file");
  expect(dialog()?.textContent).toContain("No Sync Template result was read.");
  expect(dialog()?.textContent).not.toContain("has merged");
  expect(dialog()?.querySelector('[data-kind="run"]')).toBeNull();
  await act(async () => document.body.click());
  expect(dialog()).toBeNull();
});

it("reopens a rung from its selection and anchors a stepped dispatch member at a pending fork", async () => {
  setOpenSelection({ kind: "rung", id: "partition" });
  await mount(snapshot1116());
  expect(dialog()?.dataset.selection).toBe("rung~partition");
  await act(async () => setOpenSelection({ kind: "item", id: "rollout" }));
  expect(dialog()?.dataset.selection).toBe("item~rollout");
  expect(container.querySelector('[data-rung="indexer"]')?.getAttribute("aria-expanded")).toBe(
    "true",
  );
});
