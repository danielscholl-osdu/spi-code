// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Envelope, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import briefing from "../../../../../fixtures/rib-59d6895/oracle/briefing.json?raw";
import releases from "../../../../../fixtures/rib-59d6895/oracle/releases.json?raw";
import { testSnapshot } from "../../store/test-snapshot.js";
import { watchStore } from "../../store/watch.js";
import Releases from "./index.js";

const container = document.createElement("div");
let root: ReturnType<typeof createRoot> | undefined;
const previous = watchStore.getState();

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  watchStore.setState(previous);
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
    expect(drawn).toHaveLength(2);
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
    figure: fact.querySelector("strong")?.textContent,
    label: fact.querySelector("div")?.textContent,
  }));

const duplicateKeyErrors = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter((call) => call.some((arg) => String(arg).includes("same key")));

it("keeps every stat that shares an anchor across switching and updating release details", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const body = testSnapshot(briefing, releases);
    const [first, second] = body.releases.lines;
    if (!first || !second) throw new Error("oracle has fewer than two release lines");
    expect(first.stats.filter((stat) => stat.anchor === "components").length).toBeGreaterThan(1);
    watchStore.setState({ snapshot: { cursor: body.cursor, body } });
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<Releases />));
    for (const line of body.releases.lines)
      expect(drawnStats(line.id)).toEqual(
        line.stats.map(({ anchor, figure, label }) => ({ anchor, figure, label })),
      );

    await act(async () =>
      container.querySelector<HTMLButtonElement>(`[data-rel="${second.id}"]`)?.click(),
    );
    expect(
      container.querySelector(`[data-rel-detail="${second.id}"]`)?.hasAttribute("hidden"),
    ).toBe(false);

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
      stats.map(({ anchor, figure, label }) => ({ anchor, figure, label })),
    );
    expect(container.querySelectorAll(`[data-rel-detail="${first.id}"] .pane-fact`)[1]).toBe(kept);

    await act(async () =>
      container.querySelector<HTMLButtonElement>(`[data-rel="${first.id}"]`)?.click(),
    );
    expect(container.querySelector(`[data-rel-detail="${first.id}"]`)?.hasAttribute("hidden")).toBe(
      false,
    );
    expect(duplicateKeyErrors(errors)).toEqual([]);
  } finally {
    errors.mockRestore();
  }
});
