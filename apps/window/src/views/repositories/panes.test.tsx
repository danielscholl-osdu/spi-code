// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NotesState } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { testSnapshot } from "../../store/test-snapshot.js";
import { watchStore } from "../../store/watch.js";
import Releases from "../releases/index.js";
import Repositories from "./index.js";

const fixture = (name: string) =>
  readFileSync(resolve("fixtures/rib-59d6895/oracle", name), "utf8");
const snapshot = () => testSnapshot(fixture("briefing.json"), fixture("releases.json"));
const oracle = new DOMParser().parseFromString(fixture("console.html"), "text/html");
const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, "");
const container = document.createElement("div");
let root: ReturnType<typeof createRoot> | undefined;

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
  watchStore.setState({ snapshot: null, selection: null });
});

it("matches every repository value and detail in the frozen rib console and selects each row", async () => {
  const body = snapshot();
  await render(<Repositories />, body);
  expect(text(container.querySelector('[data-view-pane="repositories"]'))).toBe(
    text(oracle.querySelector('[data-view-pane="repositories"]')),
  );
  expect(
    container.querySelector("[data-repo-detail]:not([hidden])")?.getAttribute("data-repo-detail"),
  ).toBe(body.briefing.repositories.first);
  for (const repo of body.briefing.repositories.rows) {
    const row = container.querySelector<HTMLButtonElement>(`[data-repo="${repo.id}"]`);
    await act(async () => row?.click());
    const detail = container.querySelector<HTMLElement>(`[data-repo-detail="${repo.id}"]`);
    expect(row?.getAttribute("aria-pressed")).toBe("true");
    expect(detail?.hidden).toBe(false);
    expect(container.querySelectorAll("[data-repo-detail]:not([hidden])")).toHaveLength(1);
    expect(text(detail)).toBe(text(oracle.querySelector(`[data-repo-detail="${repo.id}"]`)));
    await act(async () => detail?.querySelector("button")?.click());
    expect(watchStore.getState().selection).toEqual({ id: repo.id });
  }
});

it("matches every release line and detail in the frozen rib console and selects each month", async () => {
  const body = snapshot();
  await render(<Releases />, body);
  expect(text(container.querySelector('[data-view-pane="releases"]'))).toBe(
    text(oracle.querySelector('[data-view-pane="releases"]')),
  );
  for (const line of body.releases.lines) {
    const row = container.querySelector<HTMLButtonElement>(`[data-rel="${line.id}"]`);
    await act(async () => row?.click());
    const detail = container.querySelector<HTMLElement>(`[data-rel-detail="${line.id}"]`);
    expect(row?.getAttribute("aria-pressed")).toBe("true");
    expect(detail?.hidden).toBe(false);
    expect(container.querySelectorAll("[data-rel-detail]:not([hidden])")).toHaveLength(1);
    expect(text(detail)).toBe(text(oracle.querySelector(`[data-rel-detail="${line.id}"]`)));
    await act(async () => detail?.querySelector("button")?.click());
    expect(watchStore.getState().selection).toEqual({ id: line.id });
  }
  expect(container.querySelector("now")).toBeNull();
  expect(container.textContent).toContain("All 13 services <now> ship from SPI forks.");
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
    await render(<Releases />, body);
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

it.each([true, false])("distinguishes reading=%s with no release lines", async (reading) => {
  const body = snapshot();
  body.releases = { lines: [], reading };
  await render(<Releases />, body);
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    reading ? "Reading releases…" : "No releases read yet.",
  );
  expect(container.querySelector("[data-rel]")).toBeNull();
});

it("keeps repository selection across snapshots and falls back when that repository disappears", async () => {
  const body = snapshot();
  const repo = body.briefing.repositories.rows[0];
  if (!repo) throw new Error("Missing repository fixture");
  await render(<Repositories />, body);
  await act(async () =>
    container.querySelector<HTMLButtonElement>(`[data-repo="${repo.id}"]`)?.click(),
  );
  const updated = snapshot();
  updated.briefing.repositories.headline = "Updated repository values";
  await act(async () => watchStore.setState({ snapshot: { cursor: 2, body: updated } }));
  expect(container.querySelector('[aria-pressed="true"]')?.getAttribute("data-repo")).toBe(repo.id);
  updated.briefing.repositories.rows = updated.briefing.repositories.rows.filter(
    (row) => row.id !== repo.id,
  );
  await act(async () =>
    watchStore.setState({ snapshot: { cursor: 3, body: structuredClone(updated) } }),
  );
  expect(container.querySelector('[aria-pressed="true"]')?.getAttribute("data-repo")).toBe(
    updated.briefing.repositories.first,
  );
});

it("renders every detail line when two lines share the same text", async () => {
  const body = snapshot();
  const repo = body.briefing.repositories.rows.find((row) =>
    row.sections.some((section) => section.weight !== "quiet" && section.lines.length),
  );
  const section = repo?.sections.find((s) => s.weight !== "quiet" && s.lines.length);
  const line = section?.lines[0];
  if (!repo || !section || !line) throw new Error("Missing repository line fixture");
  section.lines = [line, { ...line }];
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await render(<Repositories />, body);
    const detail = container.querySelector(`[data-repo-detail="${repo.id}"]`);
    const lines = [...(detail?.querySelectorAll(".repo-line") ?? [])].filter(
      (el) => el.textContent === `${line.tag}${line.text}${line.sub ?? ""}`,
    );
    expect(lines).toHaveLength(2);
    expect(error.mock.calls.flat().join(" ")).not.toContain("same key");
  } finally {
    error.mockRestore();
  }
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
