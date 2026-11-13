// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import november from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import { navigate, parseRoute, routeHash } from "../../app/navigation.js";
import { type Home, PENDING } from "../../app/reachability.test-helper.js";
import { RouteView } from "../../app/routes.js";
import { selectionStore } from "../../panels/selection.js";
import { watchStore } from "../../store/watch.js";
import { watchFixtureText } from "../../test-utils/watch-fixtures.test-helper.js";
import { FORMING_RELEASES_ANCHOR, SHARED_COMPONENTS_ANCHOR } from "./anchors.js";
import Releases from "./index.js";
import { releaseSectionCases } from "./reachability.test-helper.js";

const busy = watchFixtureText("snapshot-busy.json", readFixture);

let container: HTMLDivElement;
let root: Root;
const previous = watchStore.getState();
const bridge = window.spi;
function must<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing fixture value");
  return value;
}
const snapshot = (raw = busy) => ViewSnapshotSchema.parse(JSON.parse(raw));
const pointer = (value: string) => container.querySelector(`[data-pointer="${value}"]`);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  window.spi = {
    proof: false,
    postMessage: vi.fn(),
    openExternal: vi.fn(async () => true),
    onMessage: () => () => {},
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  watchStore.setState(previous, true);
  selectionStore.getState().clear();
  window.spi = bridge;
  window.location.hash = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount(body: ViewSnapshot) {
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  await act(async () => root.render(<Releases />));
}

it("draws each busy-morning release PR's entries with core's kind and title", async () => {
  const body = snapshot();
  await mount(body);
  expect(container.querySelectorAll(".forming-release")).toHaveLength(
    must(body.releases.forming).prs.length,
  );
  for (const [index, release] of must(body.releases.forming).prs.entries()) {
    const row = pointer(`/releases/forming/prs/${index}`);
    expect(row?.querySelector(".kit-pr")?.textContent).toBe(`#${release.pr.number}`);
    expect(row?.querySelectorAll(".forming-entries li")).toHaveLength(release.entries.length);
    for (const [at, entry] of release.entries.entries()) {
      const li = pointer(`/releases/forming/prs/${index}/entries/${at}`);
      expect(li?.querySelector(".kit-chip")?.textContent).toBe(entry.kind);
      expect(li?.querySelector(".forming-entry-title")?.textContent).toBe(entry.title);
    }
  }
});

it("draws the stack, template pair and all 13 service library versions directly from today", async () => {
  const body = snapshot();
  await mount(body);
  const today = must(body.releases.today);
  expect(container.querySelector(".release-stack")?.textContent).toBe(today.platform.stack);
  expect(container.querySelector(".release-template-released")?.textContent).toBe(
    must(today.platform.template).released,
  );
  expect(container.querySelector(".release-template-proposed")?.textContent).toBe(
    must(today.platform.template).proposed,
  );
  expect(container.querySelectorAll(".release-library-version")).toHaveLength(13);
  for (const [index, version] of today.versions.entries())
    expect(
      pointer(`/releases/today/versions/${index}`)?.querySelector(".release-library-version")
        ?.textContent,
    ).toBe(version.coreLibAzure);
});

it("shows November's unread forming changes as not read with provenance, never zero", async () => {
  await mount(snapshot(november));
  const section = container.querySelector(`#${FORMING_RELEASES_ANCHOR}`);
  expect(section?.querySelector(".release-forming-text")?.textContent).toContain("not read");
  expect(section?.querySelector(".release-held")?.textContent).toBe("⌀");
  expect(section?.querySelector(".release-held")?.getAttribute("title")).toContain(
    "Release lines: not read",
  );
  expect(section?.querySelector(".forming-entries")).toBeNull();
  expect(section?.textContent).not.toMatch(/\b0\b/);
});

it.each(["github", "fleet"] as const)(
  "fails quietly when %s failed despite retained read entries",
  async (area) => {
    const body = snapshot();
    must(body.areas.find((entry) => entry.area === area)).envelope = {
      source: area,
      state: "failed",
      completeness: { kind: "complete" },
    };
    await mount(body);
    const section = container.querySelector(`#${FORMING_RELEASES_ANCHOR}`);
    expect(section?.querySelector(".release-forming-text")?.textContent).toContain("not read");
    expect(section?.querySelectorAll(".forming-entries li")).toHaveLength(0);
    expect(section?.querySelector(".release-held")?.getAttribute("title")).toContain("read failed");
  },
);

it("keeps partial PR bodies honestly unread and doesn't invent absent library versions", async () => {
  const body = snapshot();
  must(body.releases.forming).state = "partial";
  must(must(body.releases.forming).prs[0]).state = "not-read";
  must(must(body.releases.forming).prs[0]).entries = [];
  delete must(must(body.releases.today).versions[0]).coreLibAzure;
  await mount(body);
  expect(pointer("/releases/forming/prs/0")?.querySelector(".release-unread")?.textContent).toBe(
    "not read",
  );
  expect(pointer("/releases/forming/prs/1")?.querySelector(".forming-entries")).not.toBeNull();
  expect(
    pointer("/releases/today/versions/0")?.querySelector(".release-library-version")?.textContent,
  ).toBe("not read");
});

it.each([FORMING_RELEASES_ANCHOR, SHARED_COMPONENTS_ANCHOR] as const)(
  "round-trips the %s route and scrolls to its own section",
  async (section) => {
    const body = snapshot();
    watchStore.setState({ snapshot: { cursor: body.cursor, body } });
    const scrolled: Element[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      scrolled.push(this);
    });
    const route = { kind: "releases", section } as const;
    navigate(route);
    expect(parseRoute(window.location.hash)).toEqual(route);
    expect(window.location.hash).toBe(routeHash(route));
    await act(async () =>
      root.render(<RouteView route={must(parseRoute(window.location.hash))} />),
    );
    expect(scrolled).toEqual([container.querySelector(`#${section}`)]);
  },
);

it("clicks every forming and shared-component service and PR opener", async () => {
  const body = snapshot();
  await mount(body);
  for (const button of container.querySelectorAll<HTMLButtonElement>(
    ".release-section .kit-chip--service",
  )) {
    await act(async () => button.click());
    expect(window.location.hash).toBe(`#service/${button.textContent}`);
  }
  const expected = [
    ...must(body.releases.forming).prs.map(({ pr }) => pr),
    must(must(must(body.releases.today).platform.template).pr),
  ];
  const buttons = container.querySelectorAll<HTMLButtonElement>(".release-section button.kit-pr");
  expect(buttons).toHaveLength(expected.length);
  for (const [index, button] of [...buttons].entries()) {
    await act(async () => button.click());
    expect(window.spi.openExternal).toHaveBeenLastCalledWith(must(expected[index]).url);
  }
});

it("opens inspectable PRs in Detail, reports failed browser opens, and opens provenance in Evidence", async () => {
  const body = snapshot(november);
  must(must(body.releases.forming).prs[0]).pr.inspect = "pr:partition:198";
  await mount(body);
  await act(async () =>
    pointer("/releases/forming/prs/0")?.querySelector<HTMLButtonElement>(".kit-pr")?.click(),
  );
  expect(selectionStore.getState().selected).toBe("pr:partition:198");
  expect(selectionStore.getState().tab).toBe("detail");
  vi.mocked(window.spi.openExternal).mockRejectedValueOnce(new Error("offline"));
  await act(async () =>
    pointer("/releases/forming/prs/1")?.querySelector<HTMLButtonElement>(".kit-pr")?.click(),
  );
  expect(
    pointer("/releases/forming/prs/1")?.querySelector('[role="alert"]')?.textContent,
  ).toContain("Could not open");
  await act(async () => container.querySelector<HTMLButtonElement>(".release-held")?.click());
  expect(selectionStore.getState().evidenceScope).toBe("sweep");
  expect(selectionStore.getState().tab).toBe("evidence");
});

it("registers every drawn section field in reachability and clears only the place's pending scope", async () => {
  const body = snapshot();
  await mount(body);
  const home: Home = {
    name: "Releases",
    start: { name: "Releases", surface: "releases", route: { kind: "releases" } },
  };
  const cases = releaseSectionCases(body, home);
  expect(cases.some(({ pointer }) => pointer.includes("/entries/0/title"))).toBe(true);
  expect(cases.filter(({ pointer }) => pointer.endsWith("/coreLibAzure"))).toHaveLength(13);
  for (const row of cases) {
    expect(typeof row.selector).toBe("string");
    const element = container.querySelector(row.selector as string);
    expect(element, row.pointer).not.toBeNull();
    expect(
      row.attribute ? element?.getAttribute(row.attribute) : element?.textContent,
      row.pointer,
    ).toBe(row.value);
  }
  expect(PENDING).not.toHaveProperty("pending-forming");
  expect(PENDING).not.toHaveProperty("pending-releases");
});
