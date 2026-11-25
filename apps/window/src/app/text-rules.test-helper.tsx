// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectionStore } from "../panels/selection.js";
import { watchStore } from "../store/watch.js";
import { fixtureLoader, installSpi, type SnapshotName } from "../test-utils/harness.js";
import type { Read } from "../test-utils/watch-fixtures.test-helper.js";
import { navigate, type Route, relaunch } from "./navigation.js";
import { Shell } from "./Shell.js";

vi.hoisted(() => {
  process.env.TZ = "UTC";
  vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-11-06T14:02:00Z") });
});

const internal = /\bfork_upstream\b|\bgate\s+\d+\b|\bpresses\b|\bcut\b|\bclones?\b/i;
const machineTime = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\bUTC\b/;
const placeholder = /not available yet|No settled threads yet|ships in M[3-9]/i;
const ROW_LINES = ".service-row-cause, .service-row-evidence, .service-row-next";
const headlines = '.place-headline, [data-pointer$="/headline"], .release-months td:nth-child(3)';
const titles = [
  ".place-item-title, .place-item-sub, .place-item-next, .template-line-text, .template-line-sub, .env-repo-line-text, .env-repo-line small, .env-muted, .template-repo-title, .service-row-title, .service-section-count, .service-row-sub, .detail-title, [data-field], .inspector-related dd, .palette-label, .inbox-row-title, .inbox-sub",
  ".today-section-head, .today-row-fork button, .today-row-what, .today-table-calm",
  ".security-fig-label, .security-fig-who, .security-rule-title, .security-rule-sub, .security-repo-name small, .security-repo-top, .security-repo-rule-pill",
  ROW_LINES,
  ".service-fold-head",
].join(", ");

export const emoji = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|\u20E3/u;
export const todayLabelled = ["title", "aria-label"]
  .flatMap((name) => [`[aria-label="Today"][${name}]`, `[aria-label="Today"] [${name}]`])
  .join(", ");

export function violations(scope: ParentNode): string[] {
  const failures: string[] = [];
  const outsideDetail = (element: Element) =>
    !element.closest(".right-panel, [data-evidence], .section-evidence");
  for (const element of scope.querySelectorAll("*")) {
    const text = [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent)
      .join(" ");
    const copy = [text, element.getAttribute("aria-label"), element.getAttribute("title")]
      .filter(Boolean)
      .join(" ");
    if (outsideDetail(element) && (internal.test(copy) || /^(flight|quiet)$/i.test(text.trim())))
      failures.push(`internal: ${copy}`);
    if (placeholder.test(copy)) failures.push(`placeholder: ${copy}`);
    if (/\bNot stated\b/i.test(copy)) failures.push(`unstated: ${copy}`);
    if (machineTime.test(copy)) failures.push(`time: ${copy}`);
    if (element.matches("time") && Number.isNaN(Date.parse(element.getAttribute("datetime") ?? "")))
      failures.push(`time: ${element.outerHTML}`);
    if (element.matches("button") && /Open in inspector\s*·/i.test(element.textContent ?? ""))
      failures.push(`action: ${element.textContent}`);
    if (
      element.matches("h1,h2,h3,h4,ul,ol,dl") &&
      !element.textContent?.trim() &&
      !element.closest("svg")
    )
      failures.push(`empty: ${element.outerHTML}`);
  }
  for (const element of scope.querySelectorAll(headlines)) {
    const text = element.textContent?.trim() ?? "";
    if (text.split(/\s+/).length > 12) failures.push(`headline: ${text}`);
  }
  for (const element of scope.querySelectorAll(titles))
    if (emoji.test(element.textContent ?? "")) failures.push(`emoji: ${element.textContent}`);
  for (const element of scope.querySelectorAll(ROW_LINES))
    if (
      /^\s*(?:→\s*)?(?:cause|evidence|next|verdict|reason|check|job|run)\s*:/i.test(
        element.textContent ?? "",
      )
    )
      failures.push(`field label: ${element.textContent}`);
  for (const element of scope.querySelectorAll(
    "[data-slot=sidebar-footer] [data-sweep-display], .sidebar-mark",
  ))
    if (/ of |\//.test(element.textContent ?? "")) failures.push(`strip: ${element.textContent}`);
  for (const element of scope.querySelectorAll(todayLabelled))
    for (const name of ["title", "aria-label"]) {
      const value = element.getAttribute(name) ?? "";
      if (emoji.test(value)) failures.push(`emoji: ${name}="${value}"`);
    }
  return failures;
}

const previous = watchStore.getState();
let harness: ReturnType<typeof installSpi>;
export let container: HTMLDivElement;
let root: Root;

export function shellHooks() {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-11-06T14:02:00Z") });
    localStorage.clear();
    relaunch();
    selectionStore.getState().clear();
    window.location.hash = "#today";
    harness = installSpi();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    selectionStore.getState().clear();
    watchStore.setState(previous, true);
    harness.restore();
    relaunch();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
}

export async function open(body: ViewSnapshot, route: Route = { kind: "today" }) {
  await act(async () => root.render(null));
  await act(async () => {
    watchStore.setState({ snapshot: { cursor: body.cursor, body }, setup: null });
    navigate(route);
    root.render(<Shell />);
  });
}

export function assertRules(label: string, scope: ParentNode = document.body) {
  expect(violations(scope), label).toEqual([]);
}

/** The text rules on every route, Forks, Cmd-K and Evidence of one listed snapshot. */
export function textRulesOn(name: SnapshotName, read: Read) {
  shellHooks();
  const loadFixture = fixtureLoader(read);
  const snapshot = { name, body: loadFixture(name) };
  describe.each([snapshot])("window text rules on $name", ({ body }) => {
    const routes: Route[] = [
      { kind: "today" },
      { kind: "evidence" },
      { kind: "upstream" },
      { kind: "environment" },
      { kind: "engineering-system" },
      { kind: "releases" },
      { kind: "security" },
      ...body.stations.map(({ service }): Route => ({ kind: "service", id: service })),
      ...body.releases.lines.map(({ month }): Route => ({ kind: "release", month })),
    ];
    it.each(routes.map((route) => [JSON.stringify(route), route] as const))(
      "renders Today, strip, sidebar and place %s",
      async (_name, route) => {
        await open(body, route);
        assertRules(JSON.stringify(route));
      },
    );

    it("renders Forks and the command palette", async () => {
      await open(body, routes.at(-1));
      await act(async () => navigate({ kind: "today", tab: "forks" }));
      expect(
        container.querySelector('[data-today-tab="forks"][aria-selected="true"]'),
      ).not.toBeNull();
      assertRules("Forks");
      await act(async () => container.querySelector<HTMLButtonElement>(".find-or-ask")?.click());
      expect(document.querySelector('[role="dialog"][aria-label="Find or ask"]')).not.toBeNull();
      assertRules("Cmd-K");
    });
  });
}
