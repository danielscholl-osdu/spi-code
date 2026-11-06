// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NotesState } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import mixed from "../../../../../fixtures/watch/snapshot-mixed-59d6895.json?raw";
import {
  expectEvidenceMarks,
  expectNoEvidenceMarks,
} from "../../components/evidence/marks.test-helper.js";
import { mixedSnapshot, testSnapshot } from "../../store/test-snapshot.js";
import { watchStore } from "../../store/watch.js";
import Releases, { ReleaseMonth } from "../releases/index.js";
import Repositories from "./index.js";

const fixture = (name: string) =>
  readFileSync(resolve("fixtures/rib-59d6895/oracle", name), "utf8");
const paneStyles = readFileSync(resolve("apps/window/src/views/repositories/panes.css"), "utf8");
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

it("renders every repository's cells and Needs in Program and Forks without an in-page pane", async () => {
  const body = snapshot();
  await render(<Repositories />, body);
  expect(container.querySelector("[data-repo-detail]")).toBeNull();
  expect(container.querySelectorAll("tbody")).toHaveLength(2);
  for (const repo of body.briefing.repositories.rows) {
    const row = container.querySelector<HTMLElement>(`[data-selection-id="${repo.id}"]`);
    expect(row).not.toBeNull();
    expect(row?.querySelector('[data-column="Repository"]')?.textContent).toBe(repo.name);
    expect(row?.querySelector('[data-column="Needs"]')?.textContent).toBe(repo.title);
    for (const [label, key] of [
      ["Issues", "issues"],
      ["Pull Requests", "changes"],
      ["Dependabot Bumps", "dependabot"],
      ["Vulnerabilities", "vulnerabilities"],
      ["Code scanning", "codeScanning"],
    ] as const)
      expect(row?.querySelector(`[data-column="${label}"]`)?.textContent).toBe(
        `${repo.cells[key].text}${repo.cells[key].rest ?? ""}`,
      );
    send.mockClear();
    await act(async () => row?.click());
    expect(watchStore.getState().selection).toEqual({ id: repo.id });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "inspect.request", payload: { id: repo.id } }),
    );
    expect(row?.getAttribute("aria-selected")).toBe("true");
  }
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
    expect(badges).toHaveLength(2);
    for (const badge of badges) {
      expect(badge.textContent).toBe(label);
      expect(badge.getAttribute("data-tone")).toBe(tone);
    }
    expect(container.querySelector("[data-unread=true]")?.textContent).toBe(
      "?actions not reviewed yet",
    );
    expect(container.querySelector("li")?.textContent).toBe(line.keyChanges[0]);
    expect(container.querySelector("reviewed")).toBeNull();
  },
);

it("keeps a closed month with no notes neutral in the list and on its page", async () => {
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
  expect(badges).toHaveLength(2);
  for (const badge of badges) {
    expect(badge.textContent).toBe("NO NOTES YET");
    expect(badge.getAttribute("data-tone")).toBe("neutral");
  }
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
    if (!value) throw new Error("Missing running repository value");
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

it("keeps repository selection across snapshots without a local fallback selection", async () => {
  const body = snapshot();
  const repo = body.briefing.repositories.rows[0];
  if (!repo) throw new Error("Missing repository fixture");
  await render(<Repositories />, body);
  await act(async () =>
    container.querySelector<HTMLElement>(`[data-selection-id="${repo.id}"]`)?.click(),
  );
  const updated = snapshot();
  updated.briefing.repositories.headline = "Updated repository values";
  await act(async () => watchStore.setState({ snapshot: { cursor: 2, body: updated } }));
  expect(container.querySelector('[aria-selected="true"]')?.getAttribute("data-selection-id")).toBe(
    repo.id,
  );
  updated.briefing.repositories.rows = updated.briefing.repositories.rows.filter(
    (row) => row.id !== repo.id,
  );
  await act(async () =>
    watchStore.setState({ snapshot: { cursor: 3, body: structuredClone(updated) } }),
  );
  expect(container.querySelector('[aria-selected="true"]')).toBeNull();
});

it("shows explicit unread messages before any snapshot arrives", async () => {
  await render(
    <>
      <Repositories />
      <Releases />
    </>,
  );
  await act(async () => watchStore.setState({ snapshot: null }));
  expect(container.textContent).toContain("No repositories read yet.");
  expect(container.textContent).toContain("No releases read yet.");
});

it("gives each repository section one evidence line, never a mark beside a value", async () => {
  const body = mixedSnapshot(mixed, [
    { path: "/briefing/repositories/rows/2/cells/issues", areas: ["lifecycle"] },
    { path: "/briefing/repositories/facts/1/figure", areas: ["lifecycle"] },
  ]);
  await render(<Repositories />, body);
  const pane = container.querySelector('[data-view-pane="repositories"]');
  if (!pane) throw new Error("Repositories did not render");
  expectEvidenceMarks(pane, body, {
    sections: [
      ["/briefing/repositories/headline"],
      ["/briefing/repositories/facts"],
      ["/briefing/repositories/rows"],
    ],
  });
});

it("marks no repository value from the real mixed fixture, whose repository areas are observed", async () => {
  const body = mixedSnapshot(mixed);
  await render(<Repositories />, body);
  const pane = container.querySelector('[data-view-pane="repositories"]');
  if (!pane) throw new Error("Repositories did not render");
  expectEvidenceMarks(pane, body, {
    sections: [
      ["/briefing/repositories/headline"],
      ["/briefing/repositories/facts"],
      ["/briefing/repositories/rows"],
    ],
  });
  expect(pane.querySelectorAll("[data-inferred]").length).toBe(0);
});

it.each(["failed", "stale"] as const)(
  "puts a %s release read on the Releases section line and nowhere on the lines",
  async (state) => {
    const body = mixedSnapshot(mixed);
    const releaseSources = body.provenance.filter(({ path }) => path.startsWith("/releases/"));
    expect(releaseSources).toHaveLength(body.releases.lines.length);
    for (const source of releaseSources) expect(source).toHaveProperty("envelope");
    body.provenance = body.provenance.map((entry) =>
      entry.path.startsWith("/releases/")
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
    expect(line[0]?.getAttribute("data-section-evidence")).toBe("/releases");
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
    const line = pane.querySelector('[data-section-evidence="/releases"]');
    expect(line?.hasAttribute("data-inferred") ?? false).toBe(inferred);
    if (inferred) expect(line?.getAttribute("title")).toContain("Fleet membership");
    for (const [i] of body.releases.lines.entries()) {
      const drawn = pane.querySelectorAll(`[data-pointer="/releases/lines/${i}"]`);
      expect(drawn).toHaveLength(1);
      for (const element of drawn) expect(element.querySelector("[data-inferred]")).toBeNull();
    }
  },
);

it.each([
  ["repositories", <Repositories key="r" />],
  ["releases", <Releases key="l" />],
] as const)("draws no envelope or marker on the plain %s fixture", async (name, view) => {
  await render(view);
  const pane = container.querySelector(`[data-view-pane="${name}"]`);
  if (!pane) throw new Error(`${name} did not render`);
  expectNoEvidenceMarks(pane);
});
