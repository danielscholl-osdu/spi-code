// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import novemberRaw from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import badRaw from "../../../../../fixtures/watch/snapshot-bad.json?raw";
import busyRaw from "../../../../../fixtures/watch/snapshot-busy.json?raw";
import calmRaw from "../../../../../fixtures/watch/snapshot-calm.json?raw";
import { createSelectionStore } from "../../panels/selection.js";
import { createWatchStore } from "../../store/watch.js";
import { clockTime } from "../../time.js";
import { FORMING_RELEASES_ANCHOR, SHARED_COMPONENTS_ANCHOR } from "../releases/anchors.js";
import Today from "./index.js";
import { Releases } from "./Releases.js";

const RAW = { busy: busyRaw, calm: calmRaw, bad: badRaw, "1106": novemberRaw };
const morning = (name: keyof typeof RAW) => ViewSnapshotSchema.parse(JSON.parse(RAW[name]));
const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

async function mount(body: ViewSnapshot) {
  const selection = createSelectionStore({ postMessage: vi.fn() });
  const onNavigate = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(<Releases snapshot={body} onNavigate={onNavigate} selection={selection} />),
  );
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return { container, onNavigate, selection };
}

const q = (container: ParentNode, selector: string) => {
  const element = container.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`No ${selector}`);
  return element;
};
const click = (element: HTMLElement) => act(async () => element.click());

/** The morning with one area's envelope replaced. */
function withArea(
  body: ViewSnapshot,
  area: string,
  envelope: ViewSnapshot["areas"][number]["envelope"],
) {
  body.areas = body.areas.map((entry) => (entry.area === area ? { ...entry, envelope } : entry));
  return ViewSnapshotSchema.parse(body);
}

it("mounts in Today's Releases slot, beside In motion", async () => {
  const body = morning("busy");
  const store = createWatchStore(vi.fn(), createSelectionStore({ postMessage: vi.fn() }));
  store.setState({ snapshot: { cursor: body.cursor, body } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Today store={store} />));
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  expect(q(container, '.today-lower [data-today-slot="releases"] .today-releases')).toBeTruthy();
});

it("draws all 13 busy versions in core's order, filled column-first, never folded", async () => {
  const body = morning("busy");
  const versions = body.releases.today?.versions ?? [];
  expect(versions).toHaveLength(13);
  const { container } = await mount(body);
  const grid = q(container, ".today-release-versions");
  expect(grid.style.getPropertyValue("--release-rows")).toBe("5");
  const cells = [...grid.querySelectorAll<HTMLElement>(".today-release")];
  expect(cells.map((cell) => cell.dataset.service)).toEqual(versions.map(({ service }) => service));
  expect(cells.map((cell) => q(cell, ".today-release-released").textContent)).toEqual(
    versions.map((version) => (version.state === "released" ? version.released : "")),
  );
  expect(container.querySelector("details, summary, .today-folded")).toBeNull();
  expect(container.textContent).not.toMatch(/\d+ more\b/);
});

it("draws an arrow only for a version with an open release PR, named as that PR", async () => {
  const body = morning("busy");
  const versions = body.releases.today?.versions ?? [];
  const { container } = await mount(body);
  const withPr = versions.filter((version) => version.state === "released" && version.pr);
  expect(withPr.length).toBeGreaterThan(0);
  expect(withPr.length).toBeLessThan(versions.length);
  for (const version of versions) {
    const cell = q(container, `.today-release[data-service="${version.service}"]`);
    const arrow = cell.querySelector<HTMLElement>(".today-release-arrow");
    if (version.state !== "released" || !version.pr) {
      expect(arrow, version.service).toBeNull();
      continue;
    }
    expect(arrow?.title).toBe(`release PR #${version.pr.number}`);
    expect(arrow?.getAttribute("aria-label")).toBe(`release PR #${version.pr.number}`);
    expect(q(cell, ".today-release-proposed").textContent).toBe(version.proposed);
    expect(q(cell, ".today-release-released").textContent).toBe(version.released);
    expect(arrow?.dataset.prUrl).toBe(version.pr.url);
  }
});

it("names each pair from core, 'released 1.4.1, proposed 1.4.2', as one group", async () => {
  const body = morning("busy");
  const { container } = await mount(body);
  for (const version of body.releases.today?.versions ?? []) {
    if (version.state !== "released") continue;
    const pair = q(container, `.today-release[data-service="${version.service}"] fieldset`);
    expect(pair.getAttribute("aria-label")).toBe(version.text);
    expect(pair.getAttribute("aria-label")).toBe(
      version.proposed
        ? `released ${version.released}, proposed ${version.proposed}`
        : `released ${version.released}`,
    );
  }
});

it("draws the platform line and core-lib-azure's spread from core", async () => {
  const body = morning("busy");
  const platform = body.releases.today?.platform;
  const { container } = await mount(body);
  const line = q(container, ".today-release-platform");
  expect(q(line, ".today-release-open").title).toBe(platform?.text);
  expect(line.textContent).toContain(platform?.stack);
  expect(q(line, ".today-release-template").textContent).toBe(
    `template ${platform?.template?.released} → ${platform?.template?.proposed}`,
  );
  expect(q(line, ".today-release-template").title).toBe(
    `release PR #${platform?.template?.pr?.number}`,
  );
  expect(
    [...line.querySelectorAll<HTMLElement>(".kit-segment")].map((segment) => [
      segment.title,
      Number(segment.dataset.count),
    ]),
  ).toEqual(platform?.coreLibAzure.map(({ version, count }) => [`${version} ${count}`, count]));
  expect(q(line, ".kit-segmented").getAttribute("aria-label")).toBe(platform?.text);
});

it("draws the unreleased kinds as one stacked bar with a legend, and Notable in words", async () => {
  const body = morning("busy");
  const forming = body.releases.forming;
  const { container } = await mount(body);
  const changes = q(container, ".today-release-changes");
  expect(changes.querySelectorAll(".kit-stacked-bar")).toHaveLength(1);
  expect(q(changes, ".kit-stacked-bar").getAttribute("aria-label")).toBe(forming?.text);
  expect(
    [...changes.querySelectorAll<HTMLElement>(".kit-legend li")].map((li) => [
      li.dataset.segment,
      li.querySelector("b")?.textContent,
    ]),
  ).toEqual(
    Object.entries(forming?.kinds ?? {})
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => [kind, String(count)]),
  );
  expect(
    [...container.querySelectorAll(".today-release-notable button")].map((b) => b.textContent),
  ).toEqual(forming?.notable.map(({ text }) => text));
  expect(changes.textContent).not.toContain("not read");
});

it("draws calm's forming line in core's words, with no empty bar or 0", async () => {
  const body = morning("calm");
  const { container } = await mount(body);
  const changes = q(container, ".today-release-changes");
  expect(q(changes, ".today-release-quiet").textContent).toBe(body.releases.forming?.text);
  expect(changes.querySelector(".kit-stacked")).toBeNull();
  expect(container.querySelector(".today-release-arrow")).toBeNull();
  expect(container.querySelector(".today-releases-held")).toBeNull();
  expect(container.querySelector("[data-unread]")).toBeNull();
});

it("on 6 Nov's unread releases: ⌀, muted versions and 'not read this sweep', never 0", async () => {
  const body = morning("1106");
  expect(body.releases.today?.unread).toBeDefined();
  expect(body.releases.forming?.state).toBe("not-read");
  const { container } = await mount(body);
  const held = q(container, ".today-releases-held");
  expect(held.textContent).toBe("⌀not read");
  expect(held.dataset.areas).toBe("releases");
  expect(held.title).toContain("Release lines: not read");
  expect(container.querySelector(".today-releases-grid")?.hasAttribute("data-unread")).toBe(true);
  expect(container.querySelectorAll(".today-release")).toHaveLength(13);
  expect(q(container, ".today-release-changes .today-release-unread").textContent).toBe(
    "not read this sweep",
  );
  expect(container.querySelector(".today-release-changes")?.textContent).not.toMatch(/\b0\b/);
  expect(container.querySelector(".today-release-changes .kit-stacked")).toBeNull();
  expect(container.querySelector(".today-release-notable")).toBeNull();
});

it("shows the releases area's last good time beside ⌀ when core has one", async () => {
  const body = morning("1106");
  const lastGood = "2026-11-06T13:02:00.000Z";
  if (body.releases.today?.unread) body.releases.today.unread.lastGood = lastGood;
  const { container } = await mount(ViewSnapshotSchema.parse(body));
  const held = q(container, ".today-releases-held");
  expect(held.querySelector("time")?.getAttribute("dateTime")).toBe(lastGood);
  expect(held.textContent).toBe(`⌀from ${clockTime(lastGood, { hint: false })}`);
});

it("on bad, takes ⌀ and muting from the failed GitHub read the block's provenance names", async () => {
  const body = morning("bad");
  expect(body.releases.today?.unread).toBeUndefined();
  const github = body.areas.find(({ area }) => area === "github")?.envelope;
  expect(github?.state).toBe("failed");
  const { container } = await mount(body);
  const held = q(container, ".today-releases-held");
  expect(held.title).toContain("GitHub issues and PRs: read failed");
  expect(held.querySelector("time")?.getAttribute("dateTime")).toBe(
    github?.state === "failed" ? github.observedAt : undefined,
  );
  expect(container.querySelector(".today-releases-grid")?.hasAttribute("data-unread")).toBe(true);
  expect(q(container, ".today-release-changes .today-release-unread").textContent).toBe(
    "not read this sweep",
  );
  expect(container.querySelector(".today-release-notable")).toBeNull();
});

it("on bad with GitHub read, draws no ⌀ and no muting: nothing it reads is unread or cut", async () => {
  const body = morning("bad");
  const fleet = body.areas.find(({ area }) => area === "fleet")?.envelope;
  if (!fleet) throw new Error("bad carries no fleet area");
  const { container } = await mount(withArea(body, "github", { ...fleet, source: "github" }));
  expect(container.querySelector(".today-releases-held")).toBeNull();
  expect(container.querySelector("[data-unread]")).toBeNull();
  expect(container.querySelector(".today-release-changes .kit-stacked-bar")).not.toBeNull();
});

it("takes ⌀ from a cut read it draws from, and ignores a cut read it doesn't", async () => {
  const cut = (source: string) => ({
    source,
    state: "incomplete" as const,
    observedAt: "2026-11-06T14:02:00.133Z",
    completeness: { kind: "cut" as const, reason: "page_limit", read: 9, total: 13 },
  });
  const radar = await mount(withArea(morning("busy"), "radar", cut("radar")));
  expect(radar.container.querySelector(".today-releases-held")).toBeNull();
  const fleet = await mount(withArea(morning("busy"), "fleet", cut("fleet")));
  expect(q(fleet.container, ".today-releases-held").title).toContain(
    "Fleet membership: read only in part",
  );
  expect(fleet.container.querySelector(".today-releases-grid")?.hasAttribute("data-unread")).toBe(
    true,
  );
  expect(fleet.container.querySelector(".today-release-changes .kit-stacked-bar")).not.toBeNull();
});

it("opens a version's release, its arrow's release PR and a notable change in Detail", async () => {
  const body = morning("busy");
  const { container, selection } = await mount(body);
  const version = body.releases.today?.versions.find(
    (entry) => entry.state === "released" && entry.pr,
  );
  if (version?.state !== "released" || !version.pr) throw new Error("busy has no release PR");
  const cell = `.today-release[data-service="${version.service}"]`;
  await click(q(container, `${cell} .today-release-released`));
  expect(selection.getState().row).toMatchObject({
    id: `release:${version.service}`,
    kind: "release-version",
  });
  expect(selection.getState().row?.fields).toContainEqual({
    label: "Release PR",
    value: `#${version.pr.number}`,
    href: version.pr.url,
  });
  await click(q(container, `${cell} .today-release-arrow`));
  expect(selection.getState().row).toMatchObject({
    id: `release-pr:${version.service}`,
    kind: "release-pr",
  });
  expect(selection.getState().row?.fields).toContainEqual({
    label: "Proposes",
    value: version.proposed,
  });
  const notable = body.releases.forming?.notable[0];
  await click(q(container, ".today-release-notable li:first-child button"));
  expect(selection.getState().row).toMatchObject({
    id: "release-notable:0",
    kind: "release-notable",
    title: notable?.title,
  });
  expect(selection.getState().row?.fields).toContainEqual({
    label: "Release PR",
    value: `#${notable?.pr.number}`,
    href: notable?.pr.url,
  });
});

it("opens Releases at the forming changes, the shared components, and its top", async () => {
  const { container, onNavigate } = await mount(morning("busy"));
  await click(q(container, ".today-release-changes .today-release-open"));
  expect(onNavigate).toHaveBeenLastCalledWith({
    kind: "releases",
    section: FORMING_RELEASES_ANCHOR,
  });
  await click(q(container, ".today-release-platform .today-release-open"));
  expect(onNavigate).toHaveBeenLastCalledWith({
    kind: "releases",
    section: SHARED_COMPONENTS_ANCHOR,
  });
  await click(q(container, ".today-releases-heading"));
  expect(onNavigate).toHaveBeenLastCalledWith({ kind: "releases" });
});

it("opens the sweep's Evidence from ⌀", async () => {
  const { container, selection } = await mount(morning("bad"));
  await click(q(container, ".today-releases-held"));
  expect(selection.getState()).toMatchObject({
    open: true,
    tab: "evidence",
    evidenceScope: "sweep",
  });
});
