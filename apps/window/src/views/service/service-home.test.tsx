// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import recorded from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { readGenerated } from "../../../../../scripts/watch-generated.mjs";
import {
  navigate,
  parseRoute,
  type Registry,
  relaunch,
  setOpenSelection,
  useNavigation,
} from "../../app/navigation.js";
import {
  createTitleStore,
  TitleEnd,
  TitleProvider,
  TitleRow,
  type TitleStore,
} from "../../app/title-row.js";
import { buildPaletteGroups } from "../../palette/palette.logic.js";
import { createSelectionStore } from "../../panels/selection.js";
import { PINS_STORAGE_KEY, readPins, SEED_PINS } from "../../store/pins.js";
import { createWatchStore } from "../../store/watch.js";
import { threadStore } from "../../threads/store.js";
import { when } from "../../time.js";
import { ageInOneUnit } from "../today/parts.js";
import nov16 from "../today/snapshot-1116.json?raw";
import ServicePage from "./index.js";

const sixteenth = () => ViewSnapshotSchema.parse(JSON.parse(nov16));
const sixth = (variant?: "unread") =>
  ViewSnapshotSchema.parse(
    JSON.parse(variant ? readGenerated("snapshot-1106-unread.json") : recorded),
  );

let container: HTMLElement;
let unmount = async () => {};

function Routed({ registry }: { registry: Registry }) {
  const { route } = useNavigation(registry);
  return <div data-route={route.kind}>{registry.views[route.kind]?.(route as never)}</div>;
}

async function mount(body: ViewSnapshot, hash: string, titles?: TitleStore) {
  window.location.hash = hash;
  const watch = createWatchStore(vi.fn(), createSelectionStore({ postMessage: vi.fn() }));
  watch.setState({ snapshot: { cursor: body.cursor, body } });
  const registry: Registry = {
    views: {
      today: () => <p data-today="">Today</p>,
      evidence: () => <p data-evidence="">Evidence</p>,
      service: (route) => (
        <ServicePage id={route.id} tab={route.tab} row={route.row} store={watch} />
      ),
    },
    fallback: { kind: "today" },
  };
  container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <TitleProvider value={titles ?? null}>
        {titles && (
          <>
            <div className="centre-title">
              <TitleRow store={titles} fallback="" />
            </div>
            <div className="centre-end">
              <TitleEnd store={titles} />
            </div>
          </>
        )}
        <Routed registry={registry} />
      </TitleProvider>,
    ),
  );
  unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return (next: ViewSnapshot) =>
    act(async () => watch.setState({ snapshot: { cursor: next.cursor, body: next } }));
}

const $ = <T extends Element = HTMLElement>(selector: string) =>
  container.querySelector<T>(selector);
const click = (selector: string) => act(async () => $(selector)?.click());
const openRow = () => $("li[data-open]")?.getAttribute("data-row");
const head = (row: string) => $(`li[data-row="${row}"] .service-row-head`);

beforeEach(() => {
  window.location.hash = "";
});

const initialThreadState = threadStore.getState();
afterEach(async () => {
  await unmount();
  threadStore.setState(initialThreadState, true);
  await act(async () => setOpenSelection(null));
  window.location.hash = "";
  localStorage.removeItem(PINS_STORAGE_KEY);
  relaunch();
});

it("opens a station's row and a door's row on Overview with focus on it", async () => {
  await mount(sixteenth(), "#service/search");
  expect(openRow()).toBeUndefined();

  await click('button[data-station="upstream"]');
  expect(parseRoute(window.location.hash)).toEqual({
    kind: "service",
    id: "search",
    tab: "overview",
    row: "sync-run:search",
  });
  expect(openRow()).toBe("sync-run:search");
  expect(document.activeElement).toBe(head("sync-run:search"));
  expect(head("sync-run:search")?.getAttribute("aria-expanded")).toBe("true");
  expect($("li[data-open] .service-row-cause")?.textContent).toContain("Sync Upstream failed");

  const door = "can:repositories:https://github.com/Azure/osdu-spi-search/pull/68";
  await click('button[data-door="dependabot"]');
  expect(openRow()).toBe(door);
  expect(document.activeElement).toBe(head(door));

  const again = $<HTMLButtonElement>('button[data-door="dependabot"]');
  again?.focus();
  const scrolled = vi.fn();
  const row = $(`li[data-row="${door}"]`);
  if (row) row.scrollIntoView = scrolled;
  await act(async () => again?.click());
  expect(openRow()).toBe(door);
  expect(document.activeElement).toBe(head(door));
  expect(scrolled).toHaveBeenCalled();
});

it("draws a station or door that holds no row as no button", async () => {
  await mount(sixteenth(), "#service/entitlements");
  expect($('[data-station="main"]')?.tagName).toBe("DIV");
  expect($('[data-door="other"]')?.tagName).toBe("SPAN");
  expect($('[data-door="release"]')?.tagName).toBe("BUTTON");
  expect($('[data-door="template"]')).toBeNull();
  expect($('[data-station="integration"]')?.tagName).toBe("BUTTON");
});

it("opens the tab and the row a route names, and closes the row back to the tab", async () => {
  await mount(sixteenth(), "#service/search/overview/gate2%3Asearch");
  expect($('[role="tab"][aria-selected="true"]')?.textContent).toBe("Overview");
  expect(openRow()).toBe("gate2:search");

  await click('li[data-row="gate2:search"] .service-row-head');
  expect(openRow()).toBeUndefined();
  expect(parseRoute(window.location.hash)).toEqual({
    kind: "service",
    id: "search",
    tab: "overview",
  });

  await act(async () => navigate({ kind: "service", id: "search", tab: "unknown", row: "x" }));
  expect($('[role="tab"][aria-selected="true"]')?.textContent).toBe("Overview");
  expect(openRow()).toBeUndefined();
});

it.each([
  ["read", sixteenth, "file", "Nothing waiting on you"],
  [
    "not read",
    () => sixth("unread"),
    "crs-catalog",
    "⌀ Part of this fork was not read. Evidence ›",
  ],
])("opens a quiet fork whose rows were %s on its one line", async (_, body, id, line) => {
  await mount(body(), `#service/${id}`);
  expect($(".service-quiet")?.textContent).toBe(line);
  expect($('[data-section="blocked"], [data-section="waiting"]')).toBeNull();
  if (id === "crs-catalog") {
    await click(".service-quiet a");
    expect(parseRoute(window.location.hash)).toEqual({
      kind: "evidence",
      from: { kind: "service", id },
    });
  }
});

it("still opens the service page on Overview from a link that names only the service", async () => {
  await mount(sixteenth(), "#today");
  expect($("[data-today]")).not.toBeNull();
  await act(async () => navigate({ kind: "service", id: "indexer" }));
  expect($('[data-view-pane="service"]')?.getAttribute("aria-label")).toBe("indexer");
  expect($('[role="tab"][aria-selected="true"]')?.textContent).toBe("Overview");
  expect($('[data-section="blocked"]')).not.toBeNull();
});

it("puts the pin control at the top row's end, and the template icon reads the home", async () => {
  const titles = createTitleStore();
  await mount(sixteenth(), "#service/search", titles);
  const control = () => $<HTMLButtonElement>(".centre-end > .pin-control");
  expect($(".centre-title h1")?.textContent).toBe("search");
  expect($(".centre-title [data-template]")?.getAttribute("data-template")).toBe("behind");
  await act(async () => control()?.click());
  expect(readPins()).toEqual([...SEED_PINS, "search"]);
  await act(async () => control()?.click());
  expect(readPins()).toEqual(SEED_PINS);

  await act(async () => navigate({ kind: "service", id: "file" }));
  expect($(".centre-title [data-template]")?.getAttribute("data-template")).toBe("current");
  const unknown = sixteenth();
  const home = unknown.services?.find(({ service }) => service === "file")?.home;
  if (home) home.template = "unknown";
  await unmount();
  await mount(unknown, "#service/file", createTitleStore());
  expect($("[data-template]")).toBeNull();
});

it("filters Merged to merged PRs and gives only Waiting on you gates an amber tone", async () => {
  const body = sixteenth();
  await mount(body, "#service/search/pulls");
  const service = body.services?.find(({ service }) => service === "search");
  const waiting = new Set(
    service?.home?.overview
      .filter(({ section }) => section === "waiting")
      .map((row) => row.links[0]?.url),
  );
  const visible = () => [...container.querySelectorAll<HTMLElement>("[data-work=pr] li[data-row]")];
  const amber = visible().filter((row) => row.querySelector('[data-tone="warning"]'));
  expect(amber.map(({ dataset }) => dataset.row)).toEqual(["77", "76"]);
  expect(amber.every((row) => waiting.has(row.querySelector("a")?.href))).toBe(true);
  expect($('li[data-row="71"] [data-tone="error"]')).not.toBeNull();

  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.startsWith("Merged "))
      ?.click(),
  );
  const merged = service?.work?.pulls.rows
    .filter(({ state }) => state === "merged")
    .map(({ number }) => String(number));
  expect(visible().map(({ dataset }) => dataset.row)).toEqual(merged);
  expect($('li[data-row="81"]')).toBeNull();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "All")
      ?.click(),
  );
  expect($('li[data-row="81"]')).not.toBeNull();
});

it("draws a thread's PR dashed on the place before a sweep holds it, then solid and owned once", async () => {
  const swept = sixteenth();
  const pr = swept.services
    ?.find(({ service }) => service === "search")
    ?.work?.pulls.rows.find(({ state }) => state === "open");
  if (!pr) throw new Error("Fixture needs an open PR on search");
  const unswept: ViewSnapshot = JSON.parse(JSON.stringify(swept), (_key, value) =>
    value === pr.url ? pr.url.replace(/\d+\/?$/, "1$&") : value,
  );
  const request = (url: string, forge: "github" | "gitlab") => ({
    id: `thread-${forge}`,
    thread: {
      scope: "search",
      title: "Fix the request",
      request: { forge, repository: "fixture/repository", requestNumber: pr.number, url },
    },
    status: "Open" as const,
    sequence: 1,
    updatedAt: 1,
    settledAt: null,
    done: false,
  });
  const mr = "https://gitlab.example.test/fixture/upstream/-/merge_requests/9";
  threadStore.setState({ threads: [request(pr.url, "github"), request(mr, "gitlab")] });
  const marks = (url: string) => ({
    pending: container.querySelectorAll(`[data-state="pending"][data-request="${url}"]`).length,
    owned: container.querySelectorAll(`[data-state="owned"][data-request="${url}"]`).length,
  });

  const swap = await mount(unswept, "#service/search/pulls");
  expect(marks(pr.url)).toEqual({ pending: 1, owned: 0 });
  expect(marks(mr)).toEqual({ pending: 0, owned: 0 });
  expect($(`[data-request="${pr.url}"]`)?.textContent).toContain("pending · not yet in a sweep");
  await swap(swept);
  expect(marks(pr.url)).toEqual({ pending: 0, owned: 1 });
  expect($(`li[data-row="${pr.number}"] [data-state="owned"]`)).not.toBeNull();

  await act(async () => navigate({ kind: "service", id: "search", tab: "upstream" }));
  expect(marks(mr)).toEqual({ pending: 1, owned: 0 });
});

const requestThread = (url: string, forge: "github" | "gitlab", requestNumber: number) => ({
  id: `thread-${forge}`,
  thread: {
    scope: "search",
    title: "Fix the request",
    request: { forge, repository: "fixture/repository", requestNumber, url },
  },
  status: "Open" as const,
  sequence: 1,
  updatedAt: 1,
  settledAt: null,
  done: false,
});
const requestMarks = (url: string) => ({
  pending: container.querySelectorAll(`[data-state="pending"][data-request="${url}"]`).length,
  owned: container.querySelectorAll(`[data-state="owned"][data-request="${url}"]`).length,
});

it("keeps a thread's PR pending when only another PR's title spells its URL", async () => {
  const snapshot = sixteenth();
  const rows = snapshot.services?.find(({ service }) => service === "search")?.work?.pulls.rows;
  const other = rows?.find(({ state }) => state === "open");
  if (!other) throw new Error("Fixture needs an open PR on search");
  const url = "https://github.com/Azure/osdu-spi-search/pull/171";
  other.title = url;
  threadStore.setState({ threads: [requestThread(url, "github", 171)] });
  await mount(snapshot, "#service/search/pulls");
  expect(requestMarks(url)).toEqual({ pending: 1, owned: 0 });
});

it.each([
  ["a trailing slash", "pulls", "https://github.com/Azure/osdu-spi-search/pull/71/"],
  ["an uppercase host", "pulls", "https://GITHUB.COM/Azure/osdu-spi-search/pull/71"],
  [
    "GitLab's route without /-/",
    "upstream",
    "https://community.opengroup.org/osdu/platform/system/search-service/merge_requests/910",
  ],
] as const)(
  "marks a thread's request owned when the sweep spells its URL with %s",
  async (_, tab, spelled) => {
    const snapshot = sixteenth();
    const canonical = {
      pulls: "https://github.com/Azure/osdu-spi-search/pull/71",
      upstream:
        "https://community.opengroup.org/osdu/platform/system/search-service/-/merge_requests/910",
    }[tab];
    const respelled: ViewSnapshot = JSON.parse(JSON.stringify(snapshot), (_key, value) =>
      value === canonical ? spelled : value,
    );
    const forge = tab === "pulls" ? "github" : "gitlab";
    threadStore.setState({
      threads: [requestThread(canonical, forge, tab === "pulls" ? 71 : 910)],
    });
    await mount(respelled, `#service/search/${tab}`);
    expect(requestMarks(canonical)).toEqual({ pending: 0, owned: 0 });
    expect(requestMarks(spelled)).toEqual({ pending: 0, owned: 1 });
  },
);

it("shows a proven tracking issue only under All and keeps its companion on the PR", async () => {
  await mount(sixteenth(), "#service/search/issues");
  expect($('li[data-row="78"]')).toBeNull();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "All")
      ?.click(),
  );
  expect($('li[data-row="78"]')?.textContent).toContain("tracks PR #77");
  await act(async () => navigate({ kind: "service", id: "search", tab: "pulls" }));
  expect($('li[data-row="77"] a[data-kind="issue"]')?.getAttribute("href")).toBe(
    "https://github.com/Azure/osdu-spi-search/issues/78",
  );
});

it("keeps the work-list filter and query when toggling from a deep-linked PR", async () => {
  await mount(sixteenth(), "#service/search/pulls/77");
  const button = (name: string) =>
    [...container.querySelectorAll(".work-filters button")].find(
      (entry) => entry.textContent === name,
    ) as HTMLButtonElement;
  await act(async () => button("All").click());
  const input = $<HTMLInputElement>(".work-filters input");
  if (!input) throw new Error("Missing Pull requests filter");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      input,
      "osdu-spi-automation",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => $<HTMLButtonElement>('li[data-row="76"] .service-row-head')?.click());
  expect($('li[data-row="76"][data-open]')).not.toBeNull();
  expect(button("All").getAttribute("aria-pressed")).toBe("true");
  expect($<HTMLInputElement>(".work-filters input")?.value).toBe("osdu-spi-automation");
  expect($('li[data-row="71"]')).toBeNull();
});

const serviceOf = (body: ViewSnapshot, id: string) => {
  const service = body.services?.find(({ service }) => service === id);
  if (!service?.home || !service.work) throw new Error(`${id} has no home`);
  return { home: service.home, work: service.work };
};
const chip = (tab: string) => $(`[data-tab="${tab}"] .service-tab-count`)?.textContent;

it("draws a failed read's retained rows under the not-read line, with the mark on the chip", async () => {
  const at = "2026-11-16T07:38:00.000Z";
  const body = sixteenth();
  const { work } = serviceOf(body, "search");
  Object.assign(work.pulls, { read: false, at });
  const count = work.pulls.count;
  expect(count).toBeGreaterThan(0);
  await mount(body, "#service/search/pulls");
  const line = $("[data-work=pr] .service-list-unread");
  expect(line?.textContent).toBe(
    `⌀ Pull requests not read. Showing the read from ${when(at, { now: Date.now() })}. Evidence ›`,
  );
  const rows = [...container.querySelectorAll("[data-work=pr] li[data-row]")];
  expect(rows.length).toBeGreaterThan(0);
  expect(line?.compareDocumentPosition(rows[0] as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(chip("pulls")).toBe(`${count} ⌀`);
  const find = buildPaletteGroups(body)
    .flatMap(({ items }) => items)
    .flatMap((item) => item.children?.items ?? [])
    .find(({ value }) => value === "on:search:pulls");
  expect(find?.count).toBe(count);
  await unmount();

  delete work.pulls.at;
  await mount(body, "#service/search/pulls");
  expect($("[data-work=pr] .service-list-unread")?.textContent).toBe(
    "⌀ Pull requests not read. Evidence ›",
  );

  Object.assign(work.pulls, { count: null, partial: true });
  await unmount();
  await mount(body, "#service/search/pulls");
  expect(chip("pulls")).toBe("⌀");
  expect($("[data-work=pr] .service-list-unread")).not.toBeNull();
});

it("keeps the mark and the not-read line on a failed tab whose retained list holds no rows", async () => {
  const at = "2026-11-16T07:38:00.000Z";
  const body = sixteenth();
  const { work } = serviceOf(body, "search");
  Object.assign(work.issues, { read: false, at, count: 0, partial: false, rows: [] });
  await mount(body, "#service/search/issues");
  expect(chip("issues")).toBe("0 ⌀");
  const find = buildPaletteGroups(body)
    .flatMap(({ items }) => items)
    .flatMap((item) => item.children?.items ?? [])
    .find(({ value }) => value === "on:search:issues");
  expect(find?.count === undefined || typeof find.count === "number").toBe(true);
  await unmount();

  Object.assign(work.issues, { count: null, partial: true });
  await mount(body, "#service/search/issues");
  expect(chip("issues")).toBe("⌀");
  expect($("[data-work=issue] .service-list-unread")?.textContent).toBe(
    `⌀ Issues not read. Showing the read from ${when(at, { now: Date.now() })}. Evidence ›`,
  );
});

it("reads a failed tab with nothing retained as it did before", async () => {
  const body = sixteenth();
  const { work } = serviceOf(body, "search");
  Object.assign(work.issues, { read: false, count: null, partial: false, rows: [] });
  await mount(body, "#service/search/issues");
  expect($("[data-work=issue] .service-list-unread")).toBeNull();
  expect($("[data-work=issue]")?.textContent).toContain("⌀ Open issues were not read.");
  expect(chip("issues")).toBe("⌀");
});

it("counts held PRs at each door of an incomplete listing, under one mark on the group", async () => {
  const body = sixteenth();
  const { home } = serviceOf(body, "storage");
  const complete = home.doors.map(({ id, count }) => [id, count]);
  const word = (id: string) => $(`[data-door="${id}"] .flow-door-word`)?.textContent;
  await mount(body, "#service/storage");
  expect($('[data-door="unread"]')).toBeNull();
  for (const [id, count] of complete)
    if (id !== "template") expect(word(String(id))).toBe(count ? `${count} open` : "None open");
  await unmount();

  for (const door of home.doors) door.count = null;
  await mount(body, "#service/storage");
  const held = home.doors.filter(({ prs }) => prs.length > 0);
  const empty = home.doors.filter(({ id, prs }) => id !== "template" && prs.length === 0);
  expect(held.length).toBeGreaterThan(0);
  expect(empty.length).toBeGreaterThan(0);
  for (const door of held) expect(word(door.id)).toBe(`${door.prs.length} open`);
  for (const door of empty) expect(word(door.id)).toBe("⌀ not read");
  const marks = container.querySelectorAll('[data-door="unread"]');
  expect(marks).toHaveLength(1);
  expect(marks[0]?.textContent).toBe("⌀");
  expect(marks[0]?.getAttribute("title")).toBeTruthy();
});

it("gives an Overview row the age Today gives it, with its clock time on hover", async () => {
  const body = sixth();
  const member = body.briefing.lines
    ?.flatMap(({ members }) => members)
    .find(({ id }) => id === "gate1:indexer");
  const since = member?.since;
  if (!member?.age || !since) throw new Error("gate1:indexer has no age");
  await mount(body, "#service/indexer");
  const age = $('li[data-row="gate1:indexer"] .service-row-age time');
  expect(age?.textContent).toBe(ageInOneUnit(member.age));
  expect(age?.textContent).toBe("2d");
  expect(age?.getAttribute("title")).toBe(when(since, { now: Date.now() }));
});

function indexerRed(rerunning = false) {
  const body = sixteenth();
  const home = body.services?.find(({ service }) => service === "indexer")?.home;
  if (!home) throw new Error("indexer missing");
  const run = "https://github.com/Azure/osdu-spi-indexer/actions/runs/18842";
  const attempt = rerunning ? 2 : 1;
  home.stations = home.stations.map((station) =>
    station.id === "main"
      ? {
          id: "main",
          state: "stopped",
          word: "Red",
          line: rerunning ? "Validation re-running · attempt 2" : "Validation failed 08:46",
          row: "main:indexer",
        }
      : station,
  );
  const [sync, ...rest] = home.overview;
  if (!sync) throw new Error("indexer rows missing");
  home.overview = [
    {
      id: "main:indexer",
      section: "blocked",
      headline: "Main build failed",
      cause: "Validation failed on main.",
      steps: [],
      links: [
        { label: `Attempt ${attempt}`, url: `${run}/attempts/${attempt}`, kind: "run" },
        {
          label: "Deployments",
          url: "https://github.com/Azure/osdu-spi-indexer/deployments",
          kind: "deploy",
        },
      ],
      failure: {
        path: "Validation › Deploy and Test › Prove",
        reason: "environment timeout",
        verdict: "Environment",
      },
      evidence: "Lane deploy failed 08:44 in attempt 1",
      jobs: "Failed in attempt 1: Deploy and Test (Prove). Validation Summary repeats it.",
      next: rerunning
        ? "Re-run in flight (attempt 2). If it fails again, diagnose the failed jobs."
        : "Re-run the failed jobs once. If it fails again, diagnose.",
      ...(rerunning ? { rerunning: true as const } : {}),
    },
    { ...sync, next: "Read halt issue #72, then open the failed Sync Upstream run." },
    ...rest.map((row) =>
      row.section === "waiting" ? { ...row, next: "Update the integration PR's branch." } : row,
    ),
  ];
  return body;
}

it("draws the indexer's red Main first in Blocked with its cause, evidence and Next, and only it washed", async () => {
  await mount(indexerRed(), "#service/indexer");
  const rows = [
    ...container.querySelectorAll<HTMLElement>('[data-section="blocked"] li[data-row]'),
  ];
  expect(rows.map((row) => row.dataset.row)).toEqual(["main:indexer", "sync-run:indexer"]);
  expect(container.querySelectorAll("li[data-lead]")).toHaveLength(1);
  const main = $('li[data-row="main:indexer"]');
  expect(main?.hasAttribute("data-lead")).toBe(true);
  expect(main?.querySelector(".service-row-cause")?.textContent).toBe(
    "Validation › Deploy and Test › Prove · environment timeout Environment",
  );
  expect(main?.querySelector(".service-row-verdict")?.textContent).toBe("Environment");
  expect(main?.querySelector(".service-row-evidence")?.textContent).toBe(
    "Lane deploy failed 08:44 in attempt 1",
  );
  expect(main?.querySelector(".service-row-next")?.textContent).toBe(
    "→Re-run the failed jobs once. If it fails again, diagnose.",
  );
  expect(main?.querySelector(".service-row-open .kit-link")?.textContent).toContain("Attempt 1");
  expect($('li[data-row="sync-run:indexer"] .service-row-next')?.textContent).toContain(
    "halt issue #72",
  );
  expect($('li[data-row="gate2:indexer"] .service-row-cause')?.textContent).not.toBe("");
  expect($('li[data-row="gate2:indexer"] .service-row-next')).not.toBeNull();
  expect($(".service-row-spin")).toBeNull();

  expect($('[data-station="main"]')?.textContent).toContain("Validation failed 08:46");
  await click('button[data-station="main"]');
  expect(openRow()).toBe("main:indexer");
  expect(document.activeElement).toBe(head("main:indexer"));
  const body = $('li[data-row="main:indexer"] .opened-body');
  expect(body?.textContent).toContain("Failed in attempt 1: Deploy and Test (Prove).");
  expect(body?.textContent).not.toContain("Re-run the failed jobs");
});

it("folds Shared work and Can wait to one focusable line each that opens its rows", async () => {
  await mount(indexerRed(), "#service/indexer");
  const folds = [...container.querySelectorAll<HTMLButtonElement>(".service-fold-head")];
  expect(folds.map((fold) => fold.textContent)).toEqual([
    "Shared work · 23 upstream provider changes to port · Counted on Upstream▸",
    expect.stringMatching(/^Can wait 7 · Alert · PR #33 · Issue #63 · /),
  ]);
  expect(folds.map((fold) => fold.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
  expect($('[data-section="can-wait"] li[data-row]')).toBeNull();
  await act(async () => folds[1]?.click());
  expect(folds[1]?.getAttribute("aria-expanded")).toBe("true");
  expect(
    container.querySelectorAll('.service-fold[data-section="can-wait"] li[data-row]'),
  ).toHaveLength(7);

  await click('button[data-door="release"]');
  expect(openRow()).toBe("can:releases:https://github.com/Azure/osdu-spi-indexer/pull/33");
});

it("keeps a rerun in flight Blocked on attempt 2 with its spinner", async () => {
  await mount(indexerRed(true), "#service/indexer");
  const main = $('li[data-row="main:indexer"]');
  expect(main?.closest('[data-section="blocked"]')).not.toBeNull();
  expect(main?.querySelector(".service-row-open .kit-link")?.textContent).toContain("Attempt 2");
  expect(
    main?.querySelector(".service-row-next .service-row-spin")?.getAttribute("aria-hidden"),
  ).toBe("true");
  expect($('[data-station="main"]')?.textContent).toContain("Validation re-running · attempt 2");
});
