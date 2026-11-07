// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type Envelope,
  type InspectResult,
  type Message,
  PROTOCOL_VERSION,
  ReleaseDocSchema,
  ViewSnapshotSchema,
} from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import briefing from "../../../../../fixtures/rib-59d6895/oracle/briefing.json?raw";
import documents from "../../../../../fixtures/rib-59d6895/oracle/release-doc.json?raw";
import releases from "../../../../../fixtures/rib-59d6895/oracle/releases.json?raw";
import { RouteView } from "../../app/routes.js";
import { RightPanel } from "../../panels/RightPanel.js";
import { selectionStore } from "../../panels/selection.js";
import { testSnapshot } from "../../store/test-snapshot.js";
import { watchStore } from "../../store/watch.js";
import Releases, { ReleaseMonth } from "./index.js";

const container = document.createElement("div");
let root: ReturnType<typeof createRoot> | undefined;
const previous = watchStore.getState();
const send = vi.fn<(message: Message) => void>();
const listeners = new Set<(message: Message) => void>();
let previousBridge: Window["spi"];

beforeEach(() => {
  previousBridge = window.spi;
  window.spi = {
    proof: false,
    postMessage: send,
    openExternal: vi.fn(async () => true),
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  send.mockClear();
  selectionStore.getState().clear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  selectionStore.getState().clear();
  watchStore.setState(previous);
  listeners.clear();
  window.spi = previousBridge;
  window.location.hash = "";
});

it.each([
  { reading: true, state: "stale" },
  { reading: false, state: "failed" },
] as const)(
  "shows a $state release read on the section line with no lines while reading=$reading",
  async ({ reading, state }) => {
    const base = testSnapshot(briefing, releases);
    const envelope = {
      source: "releases",
      state,
      observedAt: base.sweptAt,
      completeness: { kind: "complete" },
      inferred: true,
    } satisfies Envelope;
    const body = testSnapshot(briefing, releases, {
      releases: { lines: [], reading },
      provenance: [{ path: "/releases", areas: ["fleet"], envelope }],
    });
    watchStore.setState({ snapshot: { cursor: body.cursor, body } });
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<Releases />));
    const line = container.querySelector('[data-section-evidence="/releases"]');
    expect(line?.getAttribute("data-tone")).toBe(state === "failed" ? "bad" : "warn");
    expect(line?.textContent).toContain(
      `Release lines ${state === "failed" ? "read failed" : "stale"}`,
    );
    expect(line?.hasAttribute("data-inferred")).toBe(false);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      reading ? "Reading releases…" : "No releases read yet.",
    );
    expect(container.querySelector("[data-rel]")).toBeNull();
  },
);

it("finds release evidence beyond the first line and retains it when the lines become empty", async () => {
  const base = testSnapshot(briefing, releases);
  const envelope = {
    source: "releases",
    state: "failed",
    completeness: { kind: "complete" },
  } satisfies Envelope;
  const body = testSnapshot(briefing, releases, {
    provenance: [{ path: "/releases/lines/1", areas: ["fleet"], envelope }],
  });
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<Releases />));
  const line = () => container.querySelector('[data-section-evidence="/releases"]');
  expect(line()?.textContent).toContain("Release lines read failed");
  const empty = ViewSnapshotSchema.parse({
    ...base,
    cursor: 2,
    releases: { lines: [], reading: false },
    provenance: [{ path: "/releases/lines", areas: ["fleet"], envelope }],
  });
  await act(async () => watchStore.setState({ snapshot: { cursor: 2, body: empty } }));
  expect(line()?.textContent).toContain("Release lines read failed");
  expect(container.querySelector("[data-rel]")).toBeNull();
});

it.each([true, false])(
  "says inferred=%s once on the section, not per line, for legacy values without a supplemental envelope",
  async (inferred) => {
    const base = testSnapshot(briefing, releases);
    const body = testSnapshot(briefing, releases, {
      releases: { ...base.releases, lines: base.releases.lines.slice(0, 1) },
      areas: base.areas.map((entry) =>
        entry.area === "fleet"
          ? {
              area: "fleet",
              envelope: {
                source: "fleet",
                state: "fresh",
                observedAt: base.sweptAt,
                completeness: { kind: "complete" },
                inferred,
              },
            }
          : entry,
      ),
      provenance: [{ path: "/releases/lines/0", areas: ["fleet"] }],
    });
    watchStore.setState({ snapshot: { cursor: body.cursor, body } });
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<Releases />));
    const drawn = container.querySelectorAll('[data-pointer="/releases/lines/0"]');
    expect(drawn).toHaveLength(1);
    for (const element of drawn) expect(element.querySelector("[data-inferred]")).toBeNull();
    const line = container.querySelector('[data-section-evidence="/releases"]');
    if (inferred) {
      expect(line?.hasAttribute("data-inferred")).toBe(true);
      expect(line?.textContent?.trim()).toBe("inferred");
    } else expect(line).toBeNull();
  },
);

it("shows the worst release read under /releases on the section line, not the first", async () => {
  const observedAt = testSnapshot(briefing, releases).sweptAt;
  const at = (state: Envelope["state"]) =>
    ({
      source: "releases",
      state,
      observedAt,
      completeness: { kind: "complete" },
    }) satisfies Envelope;
  const body = testSnapshot(briefing, releases, {
    provenance: [
      { path: "/releases/lines/0", areas: ["fleet"], envelope: at("fresh") },
      { path: "/releases/lines/1", areas: ["fleet"], envelope: at("failed") },
    ],
  });
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<Releases />));
  const line = container.querySelector('[data-section-evidence="/releases"]');
  expect(line?.getAttribute("data-tone")).toBe("bad");
  expect(line?.textContent).toContain("Release lines read failed");
});

const drawnStats = (id: string) =>
  [...container.querySelectorAll(`[data-rel-detail="${id}"] .pane-fact`)].map((fact) => ({
    anchor: fact.getAttribute("data-anchor"),
    short: fact.querySelector(".pane-fact-short")?.textContent,
    figure: fact.querySelector("strong")?.textContent,
    label: fact.querySelector("div")?.textContent,
  }));

const duplicateKeyErrors = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter((call) => call.some((arg) => String(arg).includes("same key")));

it("keeps every stat that shares an anchor across changing and updating month pages", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const body = testSnapshot(briefing, releases);
    const [first, second] = body.releases.lines;
    if (!first || !second) throw new Error("oracle has fewer than two release lines");
    expect(first.stats.filter((stat) => stat.anchor === "components").length).toBeGreaterThan(1);
    watchStore.setState({ snapshot: { cursor: body.cursor, body } });
    document.body.append(container);
    root = createRoot(container);
    for (const line of body.releases.lines) {
      await act(async () => root?.render(<ReleaseMonth month={line.month} />));
      expect(drawnStats(line.id)).toEqual(
        line.stats.map(({ anchor, short, figure, label }) => ({ anchor, short, figure, label })),
      );
    }
    await act(async () => root?.render(<ReleaseMonth month={first.month} />));

    const kept = container.querySelectorAll(`[data-rel-detail="${first.id}"] .pane-fact`)[1];
    const stats = [
      ...first.stats.slice(0, 2).map((stat) => ({ ...stat, figure: `${stat.figure}+` })),
      { ...first.stats[1], anchor: "components", label: "a third components stat", figure: "9" },
      ...first.stats.slice(2),
    ] as typeof first.stats;
    const updated = testSnapshot(briefing, releases, {
      cursor: 2,
      releases: {
        ...body.releases,
        lines: [{ ...first, stats }, ...body.releases.lines.slice(1)],
      },
    });
    await act(async () => watchStore.setState({ snapshot: { cursor: 2, body: updated } }));
    expect(drawnStats(first.id)).toEqual(
      stats.map(({ anchor, short, figure, label }) => ({ anchor, short, figure, label })),
    );
    expect(container.querySelectorAll(`[data-rel-detail="${first.id}"] .pane-fact`)[1]).toBe(kept);

    expect(duplicateKeyErrors(errors)).toEqual([]);
  } finally {
    errors.mockRestore();
  }
});

async function mount(view: React.ReactNode, body = testSnapshot(briefing, releases)) {
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(view));
}

const docs = ReleaseDocSchema.array().parse(JSON.parse(documents));
const doc = docs[0];
if (!doc) throw new Error("Missing recorded release document");
const related: InspectResult["related"] = [
  { text: "Recorded key change", state: "Key change" },
  ...doc.highlights.map(({ title }) => ({ text: title, state: "Highlight" })),
  ...doc.changelog.flatMap(({ area, items }) =>
    items.map(({ text, type }) => ({ text, state: `${area}: ${type}` })),
  ),
  ...doc.issues.map(({ title, state }) => ({ text: title, state })),
  ...doc.rows.map(({ id, version, state, url }) => ({
    text: `${id}: ${version}`,
    state,
    ...(url ? { url } : {}),
  })),
  ...doc.links.map(({ label, url }) => ({ text: label, url, state: "Releases" })),
];
const result: InspectResult = {
  id: doc.id,
  class: "READY",
  cause: doc.headline,
  effect: doc.stateText,
  next: "",
  why: "",
  related,
  evidence: [],
  actions: [],
  approval: null,
};

async function reply(payload: InspectResult = result) {
  const request = [...send.mock.calls]
    .reverse()
    .find(([message]) => message.type === "inspect.request")?.[0];
  if (!request) throw new Error("Missing inspect request");
  await act(async () => {
    for (const listener of listeners)
      listener({
        version: PROTOCOL_VERSION,
        id: request.id,
        kind: "response",
        type: "inspect.result",
        payload,
      });
  });
  return request;
}

it("orders recorded months newest first and selects their inspect in the shared right panel", async () => {
  const body = testSnapshot(briefing, releases);
  body.releases.lines.reverse();
  await mount(
    <>
      <Releases />
      <RightPanel store={selectionStore} snapshot={body} />
    </>,
    body,
  );
  expect(container.querySelectorAll("[data-rel-detail]")).toHaveLength(0);
  const rows = [...container.querySelectorAll<HTMLElement>("[data-rel]")];
  const expected = [...body.releases.lines].sort((a, b) => b.month.localeCompare(a.month));
  expect(rows.map((row) => row.dataset.rel)).toEqual(expected.map(({ id }) => id));
  for (const [index, line] of expected.entries()) {
    const row = rows[index];
    expect(row?.textContent).toContain(line.headline);
    expect(row?.textContent).toContain(line.stateText);
    expect(row?.querySelector("[data-notes]")?.getAttribute("data-notes")).toBe(line.notes);
    await act(async () => row?.click());
    expect(selectionStore.getState().selected).toBe(line.id);
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "inspect.request", payload: { id: line.id } }),
    );
    const request = send.mock.lastCall?.[0];
    await act(async () =>
      selectionStore.getState().receive({
        version: PROTOCOL_VERSION,
        id: request?.id,
        kind: "response",
        type: "inspect.result",
        payload: { ...result, id: line.id, cause: line.headline },
      }),
    );
    expect(row?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[data-field="cause"]')?.textContent).toBe(line.headline);
    expect(row?.dataset.pointer).toBe(`/releases/lines/${body.releases.lines.indexOf(line)}`);
  }
});

it("opens a month by its name or Enter, retaining the shared selection", async () => {
  await mount(<Releases />);
  const row = container.querySelector<HTMLElement>("[data-rel]");
  await act(async () => row?.querySelector<HTMLButtonElement>("button")?.click());
  expect(window.location.hash).toBe(`#release/${doc.month}`);
  expect(selectionStore.getState().selected).toBe(doc.id);
  window.location.hash = "#releases";
  await act(async () =>
    row?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(window.location.hash).toBe(`#release/${doc.month}`);
});

it("renders the routed month's pane facts and every related document row, without selecting it", async () => {
  await mount(<RouteView route={{ kind: "release", month: doc.month }} />);
  expect(selectionStore.getState().selected).toBeNull();
  expect(container.querySelector("h1")?.textContent).toBe(`SPI ${doc.name}`);
  expect(drawnStats(doc.id)).toEqual(
    doc.stats.map(({ anchor, short, figure, label }) => ({ anchor, short, figure, label })),
  );
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Reading");
  await reply();
  const entries = [...container.querySelectorAll("[data-related-state]")];
  expect(entries).toHaveLength(related.length);
  for (const [index, entry] of related.entries()) {
    expect(entries[index]?.textContent).toContain(entry.text);
    expect(entries[index]?.textContent).toContain(entry.state);
  }
  await act(async () => selectionStore.getState().clear());
  expect(container.querySelectorAll("[data-related-state]")).toHaveLength(related.length);
  expect(container.querySelector("now")).toBeNull();
});

it("selects the month and requests its inspect when Detail is clicked", async () => {
  await mount(<ReleaseMonth month={doc.month} />);
  send.mockClear();
  const detail = container.querySelector<HTMLButtonElement>(".place-header button");
  expect(detail?.textContent).toBe("Detail");
  await act(async () => detail?.click());
  expect(selectionStore.getState().selected).toBe(`release:${doc.month}`);
  expect(selectionStore.getState().row).toMatchObject({ id: doc.id, kind: "release" });
  expect(send).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "inspect.request", payload: { id: `release:${doc.month}` } }),
  );
});

it.each(["Key change", "Highlight", "Services: new", "open", "released", "Releases"])(
  "omits absent %s document rows while retaining the other related parts",
  async (state) => {
    await mount(<ReleaseMonth month={doc.month} />);
    const remaining = related.filter((entry) => entry.state !== state);
    expect(remaining.length).toBeLessThan(related.length);
    await reply({ ...result, related: remaining });
    expect(container.querySelector(`[data-related-state="${state}"]`)).toBeNull();
    expect(container.querySelectorAll("[data-related-state]")).toHaveLength(remaining.length);
  },
);

it("omits empty key changes and document sections and renders updated pane key changes as text", async () => {
  const body = testSnapshot(briefing, releases);
  await mount(<ReleaseMonth month={doc.month} />, body);
  await reply({ ...result, related: [] });
  expect(container.querySelector('[aria-label="Key changes"]')).toBeNull();
  expect(container.querySelector('[aria-label="Document"]')).toBeNull();
  const line = body.releases.lines[0];
  if (!line) throw new Error("Missing release line");
  const keyChanges = ["Keep <reviewed> text & consumer instructions."];
  const updated = {
    ...body,
    cursor: 2,
    releases: { ...body.releases, lines: [{ ...line, keyChanges }] },
  };
  await act(async () => watchStore.setState({ snapshot: { cursor: 2, body: updated } }));
  expect(container.querySelector('[aria-label="Key changes"] li')?.textContent).toBe(keyChanges[0]);
  expect(container.querySelector("reviewed")).toBeNull();
});

it("opens every recorded per-fork URL and release link through external:open's renderer bridge", async () => {
  await mount(<ReleaseMonth month={doc.month} />);
  await reply();
  const links = [...container.querySelectorAll<HTMLAnchorElement>('[aria-label="Document"] a')];
  expect(links.map((link) => link.href)).toEqual(
    related.flatMap((entry) => (entry.url ? [entry.url] : [])),
  );
  for (const link of links) {
    await act(async () => link.click());
    expect(window.spi.openExternal).toHaveBeenLastCalledWith(link.href);
  }
  vi.mocked(window.spi.openExternal).mockResolvedValueOnce(false);
  await act(async () => links[0]?.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not open");
});

it("ignores mismatched replies, reports read errors and stops listening when the page unmounts", async () => {
  await mount(<ReleaseMonth month={doc.month} />);
  const request = await reply({ ...result, id: "release:2026-09" });
  expect(container.querySelector('[aria-label="Document"]')).toBeNull();
  await act(async () => {
    for (const listener of listeners)
      listener({
        version: PROTOCOL_VERSION,
        id: request.id,
        kind: "response",
        type: "error",
        payload: { code: "not_found", message: "Release document is not available" },
      });
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Release document is not available",
  );
  await act(async () => root?.unmount());
  root = undefined;
  expect(listeners.size).toBe(0);
});

it("keeps the document through sweep and reconnect re-reads, ignoring the earlier request's late reply", async () => {
  const body = testSnapshot(briefing, releases);
  await mount(<ReleaseMonth month={doc.month} />, body);
  const first = await reply();
  const entries = [...container.querySelectorAll("[data-related-state]")];
  expect(entries).toHaveLength(related.length);
  await act(async () =>
    watchStore.setState({
      snapshot: { cursor: 2, body: { ...body, cursor: 2 } },
    }),
  );
  const second = send.mock.lastCall?.[0];
  expect(second).toMatchObject({ type: "inspect.request", payload: { id: doc.id } });
  expect(second?.id).not.toBe(first.id);
  expect([...container.querySelectorAll("[data-related-state]")]).toEqual(entries);
  expect(container.querySelector('[role="status"]')).toBeNull();
  await act(async () => {
    for (const listener of listeners)
      listener({
        version: PROTOCOL_VERSION,
        id: first.id,
        kind: "response",
        type: "inspect.result",
        payload: { ...result, related: [{ text: "Late document", state: "Highlight" }] },
      });
  });
  expect([...container.querySelectorAll("[data-related-state]")]).toEqual(entries);
  expect(container.textContent).not.toContain("Late document");
  const refreshed = [{ text: "Refreshed document", state: "Highlight" }];
  await reply({ ...result, related: refreshed });
  expect(container.querySelectorAll("[data-related-state]")).toHaveLength(1);
  expect(container.querySelector("[data-related-state]")?.textContent).toContain(
    refreshed[0]?.text,
  );
  await act(async () => watchStore.setState({ epoch: watchStore.getState().epoch + 1 }));
  expect(send.mock.lastCall?.[0].id).not.toBe(second?.id);
  expect(container.querySelector("[data-related-state]")?.textContent).toContain(
    refreshed[0]?.text,
  );
  await reply();
  expect(container.querySelectorAll("[data-related-state]")).toHaveLength(related.length);
  expect(selectionStore.getState().selected).toBeNull();
});

it("drops the previous document when the month changes and ignores its late reply", async () => {
  const body = testSnapshot(briefing, releases);
  const next = body.releases.lines.find((line) => line.id !== doc.id);
  if (!next) throw new Error("Missing another release month");
  await mount(<ReleaseMonth month={doc.month} />, body);
  const first = await reply();
  expect(container.querySelectorAll("[data-related-state]")).toHaveLength(related.length);
  await act(async () => root?.render(<ReleaseMonth month={next.month} />));
  expect(container.querySelector('[aria-label="Document"]')).toBeNull();
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Reading release document…");
  expect(send.mock.lastCall?.[0]).toMatchObject({
    type: "inspect.request",
    payload: { id: next.id },
  });
  await act(async () => {
    for (const listener of listeners)
      listener({
        version: PROTOCOL_VERSION,
        id: first.id,
        kind: "response",
        type: "inspect.result",
        payload: result,
      });
  });
  expect(container.querySelector('[aria-label="Document"]')).toBeNull();
  await reply({
    ...result,
    id: next.id,
    related: [{ text: "Another month's document", state: "Highlight" }],
  });
  expect(container.querySelectorAll("[data-related-state]")).toHaveLength(1);
  expect(container.querySelector("[data-related-state]")?.textContent).toContain(
    "Another month's document",
  );
});

it.each(["request error", "host unavailable", "wrong id"])(
  "drops the retained document on a refresh reply with %s",
  async (failure) => {
    const body = testSnapshot(briefing, releases);
    await mount(<ReleaseMonth month={doc.month} />, body);
    await reply();
    await act(async () =>
      watchStore.setState({ snapshot: { cursor: 2, body: { ...body, cursor: 2 } } }),
    );
    expect(container.querySelectorAll("[data-related-state]")).toHaveLength(related.length);
    const request = send.mock.lastCall?.[0];
    if (!request) throw new Error("Missing refresh request");
    if (failure === "wrong id") await reply({ ...result, id: "release:2026-09" });
    else
      await act(async () => {
        for (const listener of listeners)
          listener({
            version: PROTOCOL_VERSION,
            id: failure === "host unavailable" ? crypto.randomUUID() : request.id,
            kind: "response",
            type: "error",
            payload: {
              code: failure === "host unavailable" ? "host_unavailable" : "not_found",
              message: "Release document is not available",
            },
          });
      });
    expect(container.querySelector('[aria-label="Document"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      failure === "wrong id"
        ? "Release document reply did not match the requested month."
        : "Release document is not available",
    );
    await act(async () =>
      watchStore.setState({ snapshot: { cursor: 3, body: { ...body, cursor: 3 } } }),
    );
    expect(container.querySelector('[aria-label="Document"]')).toBeNull();
    await reply();
    expect(container.querySelectorAll("[data-related-state]")).toHaveLength(related.length);
  },
);
