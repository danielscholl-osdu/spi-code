// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NotesState } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import mixed from "../../../../../fixtures/watch/snapshot-mixed-59d6895.json?raw";
import { expectNoEvidenceMarks } from "../../components/evidence/marks.test-helper.js";
import { mixedSnapshot, testSnapshot } from "../../store/test-snapshot.js";
import { watchStore } from "../../store/watch.js";
import Releases, { ReleaseMonth } from "./index.js";

const fixture = (name: string) =>
  readFileSync(resolve("fixtures/rib-59d6895/oracle", name), "utf8");
const paneStyles = readFileSync(resolve("apps/window/src/views/releases/panes.css"), "utf8");
const snapshot = () => testSnapshot(fixture("briefing.json"), fixture("releases.json"));
const container = document.createElement("div");
let root: ReturnType<typeof createRoot> | undefined;
const send = vi.fn();
let previous: Window["spi"];

beforeEach(() => {
  previous = window.spi;
  window.spi = {
    proof: false,
    openExternal: vi.fn(),
    postMessage: send,
    onMessage: () => () => {},
  };
  send.mockClear();
});

async function render(view: React.ReactNode, body = snapshot()) {
  watchStore.setState({ snapshot: { cursor: body.cursor, body }, selection: null });
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(view));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  watchStore.getState().clear();
  watchStore.setState({ snapshot: null });
  window.spi = previous;
});

it.each<{ notes: NotesState; label: string; tone: string }>([
  { notes: "none", label: "NO NOTES YET", tone: "warn" },
  { notes: "invalid", label: "NOTES FILE INVALID", tone: "bad" },
  { notes: "approved", label: "APPROVED", tone: "ok" },
  { notes: "draft", label: "DRAFT", tone: "warn" },
])(
  "renders the $notes notes state without concealing unknown review counts",
  async ({ notes, label, tone }) => {
    const body = snapshot();
    const line = body.releases.lines[0];
    if (!line) throw new Error("Missing release fixture");
    line.notes = notes;
    line.keyChanges = ["Keep <reviewed> text & consumer instructions."];
    line.stats = [
      { figure: "?", short: "Actions", label: "actions not reviewed yet", anchor: "action" },
    ];
    body.releases.lines = [line];
    await render(
      <>
        <Releases />
        <ReleaseMonth month={line.month} />
      </>,
      body,
    );
    const badges = container.querySelectorAll("[data-notes]");
    expect(badges).toHaveLength(1);
    expect(badges[0]?.closest("[data-rel]")).not.toBeNull();
    expect(badges[0]?.textContent).toBe(label);
    expect(badges[0]?.getAttribute("data-tone")).toBe(tone);
    expect(container.querySelector("[data-unread=true]")?.textContent).toBe(
      "Actions?actions not reviewed yet",
    );
    expect(container.querySelector("li")?.textContent).toBe(line.keyChanges[0]);
    expect(container.querySelector("reviewed")).toBeNull();
  },
);

it("keeps a closed month with no notes neutral in the list, leaving its page to the reading", async () => {
  const body = snapshot();
  const line = body.releases.lines[0];
  if (!line) throw new Error("Missing release fixture");
  line.open = false;
  line.notes = "none";
  body.releases.lines = [line];
  await render(
    <>
      <Releases />
      <ReleaseMonth month={line.month} />
    </>,
    body,
  );
  const badges = [...container.querySelectorAll("[data-notes]")];
  expect(badges).toHaveLength(1);
  expect(badges[0]?.closest("[data-rel]")).not.toBeNull();
  expect(badges[0]?.textContent).toBe("NO NOTES YET");
  expect(badges[0]?.getAttribute("data-tone")).toBe("neutral");
  expect(container.querySelector(`[data-rel-detail="${line.id}"] [data-notes]`)).toBeNull();
});

it("colours the shared pane's run tone with the accent", async () => {
  await render(
    <div className="watch-pane">
      <span data-tone="run">running</span>
    </div>,
  );
  const style = document.createElement("style");
  style.textContent = paneStyles;
  document.head.append(style);
  container.style.setProperty("--accent-text", "rgb(10, 20, 30)");
  try {
    const value = container.querySelector('[data-tone="run"]');
    if (!value) throw new Error("Missing running pane value");
    expect(value.textContent).toBe("running");
    expect(getComputedStyle(value).color).toBe("rgb(10, 20, 30)");
  } finally {
    style.remove();
    container.style.removeProperty("--accent-text");
  }
});

it.each([true, false])("distinguishes reading=%s with no release lines", async (reading) => {
  const body = snapshot();
  body.releases = { lines: [], reading };
  await render(<Releases />, body);
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    reading ? "Reading releases…" : "No releases read yet.",
  );
  expect(container.querySelector("[data-rel]")).toBeNull();
});

it("shows explicit unread messages before any snapshot arrives", async () => {
  await render(<Releases />);
  await act(async () => watchStore.setState({ snapshot: null }));
  expect(container.textContent).toContain("No releases read yet.");
});

it.each(["failed", "stale"] as const)(
  "puts a %s release read on the Releases section line and nowhere on the lines",
  async (state) => {
    const body = mixedSnapshot(mixed);
    const releaseSources = body.provenance.filter(({ path }) => path.startsWith("/releases/lines"));
    expect(releaseSources).toHaveLength(body.releases.lines.length + 1);
    for (const source of releaseSources) expect(source).toHaveProperty("envelope");
    body.provenance = body.provenance.map((entry) =>
      entry.path.startsWith("/releases/lines")
        ? {
            ...entry,
            envelope: {
              source: "releases",
              state,
              observedAt: body.sweptAt,
              completeness: { kind: "complete" },
              inferred: false,
            },
          }
        : entry,
    );
    await render(<Releases />, body);
    const pane = container.querySelector('[data-view-pane="releases"]');
    if (!pane) throw new Error("Releases did not render");
    const line = pane.querySelectorAll("[data-section-evidence]");
    expect(line).toHaveLength(1);
    expect(line[0]?.getAttribute("data-section-evidence")).toBe("/releases/lines");
    expect(line[0]?.textContent).toContain(
      `Release lines ${state === "failed" ? "read failed" : "stale"}`,
    );
    for (const { id } of body.releases.lines) {
      for (const selector of [`[data-rel="${id}"]`, `[data-rel-detail="${id}"]`])
        expect(pane.querySelector(`${selector} [data-envelope]`), selector).toBeNull();
    }
    expect(pane.querySelector("[data-inferred]")).toBeNull();
  },
);

it.each([
  ["unread", true, false],
  ["inferred", true, true],
  ["inferred", false, false],
  ["observed", true, false],
] as const)(
  "says inferred on the Releases line with fleet %s and release inferred=%s only when every input is",
  async (fleetState, releaseInferred, inferred) => {
    const real = mixedSnapshot(mixed);
    const fleet = {
      source: "fleet",
      state: "fresh",
      observedAt: real.sweptAt,
      completeness: { kind: "complete" },
      inferred: fleetState === "inferred",
    } as const;
    const body = {
      ...real,
      areas: real.areas.map((entry) =>
        entry.area === "fleet" && fleetState !== "unread"
          ? { area: "fleet" as const, envelope: fleet }
          : entry,
      ),
      provenance: real.provenance.map((entry) =>
        entry.envelope
          ? {
              ...entry,
              envelope: {
                source: "releases",
                state: "fresh" as const,
                observedAt: real.sweptAt,
                completeness: { kind: "complete" as const },
                inferred: releaseInferred,
              },
            }
          : entry,
      ),
    };
    await render(<Releases />, body);
    const pane = container.querySelector('[data-view-pane="releases"]');
    if (!pane) throw new Error("Releases did not render");
    const line = pane.querySelector('[data-section-evidence="/releases/lines"]');
    expect(line?.hasAttribute("data-inferred") ?? false).toBe(inferred);
    if (inferred) expect(line?.getAttribute("title")).toContain("Fleet membership");
    for (const [i] of body.releases.lines.entries()) {
      const drawn = pane.querySelectorAll(`[data-pointer="/releases/lines/${i}"]`);
      expect(drawn).toHaveLength(1);
      for (const element of drawn) expect(element.querySelector("[data-inferred]")).toBeNull();
    }
  },
);

it("keeps the month ledger's section line when Today and forming values name other reads", async () => {
  const base = mixedSnapshot(mixed);
  const failed = (source: string) =>
    ({
      source,
      state: "failed",
      observedAt: base.sweptAt,
      completeness: { kind: "complete" },
    }) as const;
  const degraded = {
    ...base,
    areas: base.areas.map((entry) =>
      entry.area === "github" || entry.area === "details"
        ? { area: entry.area, envelope: failed(entry.area) }
        : entry,
    ),
  };
  await render(<Releases />, degraded);
  const pane = () => container.querySelector('[data-view-pane="releases"]');
  const ledger = () =>
    [...(pane()?.querySelectorAll("[data-section-evidence]") ?? [])].map((line) => ({
      prefixes: line.getAttribute("data-section-evidence"),
      text: line.textContent,
      tone: line.getAttribute("data-tone"),
      title: line.getAttribute("title"),
      inferred: line.hasAttribute("data-inferred"),
    }));
  const before = ledger();
  const withToday = {
    ...degraded,
    cursor: degraded.cursor + 1,
    provenance: [
      ...degraded.provenance,
      { path: "/releases/today/readyLine", areas: ["github", "details"] },
      { path: "/releases/today/versions/0/proposed", areas: ["github"] },
      { path: "/releases/forming", areas: ["github"], envelope: failed("releases") },
    ],
  } satisfies typeof base;
  await act(async () =>
    watchStore.setState({ snapshot: { cursor: withToday.cursor, body: withToday } }),
  );
  expect(ledger()).toEqual(before);
  for (const { title } of ledger()) expect(title).not.toMatch(/GitHub|Run details/);
});

it("draws no envelope or marker on the plain releases fixture", async () => {
  await render(<Releases />);
  const pane = container.querySelector('[data-view-pane="releases"]');
  if (!pane) throw new Error("Releases did not render");
  expectNoEvidenceMarks(pane);
});
