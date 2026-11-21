// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type SecurityPane, SecurityPaneSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { readFixture } from "../../../../../../scripts/watch-generated.mjs";
import { stubActEnvironment } from "../../../test-utils/harness.js";
import { ByRepository } from "./ByRepository.js";
import { INITIAL_STATE, type SecurityActions } from "./state.js";

const fixture = (name: string): SecurityPane =>
  SecurityPaneSchema.parse(
    JSON.parse(readFixture(`fixtures/watch/generated/security/${name}.json`)),
  );
const cleanups: (() => Promise<void>)[] = [];

let restoreAct: () => void;
beforeAll(() => {
  restoreAct = stubActEnvironment();
});
afterAll(() => restoreAct());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function mount(pane: SecurityPane, laneId: "spi" | "upstream", repository: string | null) {
  const lane = pane.lanes.find(({ id }) => id === laneId);
  if (!lane) throw new Error(`No ${laneId} lane`);
  const actions: SecurityActions = {
    chooseLane: vi.fn(),
    setView: vi.fn(),
    openRule: vi.fn(),
    openRepository: vi.fn(),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const state = { ...INITIAL_STATE, view: "repository" as const, repository };
  await act(async () =>
    root.render(<ByRepository pane={pane} lane={lane} state={state} actions={actions} />),
  );
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return { actions, container };
}

const click = (element: Element | null | undefined) =>
  act(async () => {
    if (!element) throw new Error("Nothing to click");
    (element as HTMLElement).click();
  });

it("expands a file's alerts in place and opens a rule in By rule with its repository marked", async () => {
  const { actions, container } = await mount(fixture("1116"), "upstream", "crs-conversion");
  const file = [...container.querySelectorAll(".security-repo-file")].find((f) =>
    f.textContent?.startsWith("CRSConverter.java"),
  );
  const more = file?.querySelector<HTMLButtonElement>(".security-repo-more");
  expect([more?.textContent, more?.getAttribute("aria-expanded")]).toEqual([
    "62 CodeQL alerts ⌄",
    "false",
  ]);
  expect(file?.querySelectorAll(".kit-link").length).toBe(0);
  await click(more);
  const pills = [...(file?.querySelectorAll(".kit-link") ?? [])];
  expect(pills.length).toBe(62);
  expect(pills.every((p) => /^CodeQL #\d+↗$/.test(p.textContent ?? ""))).toBe(true);
  expect(pills[0]?.getAttribute("aria-label")).toMatch(/^CodeQL #\d+ in crs-conversion, high: /);
  await click(more);
  expect(file?.querySelectorAll(".kit-link").length).toBe(0);
  await click(container.querySelector(".security-repo-rule-pill"));
  expect(actions.openRule).toHaveBeenLastCalledWith(
    "upstream:code:CodeQL:java/tainted-arithmetic",
    "crs-conversion",
  );
});

it("draws the whole line of repositories with nothing once its disclosure is chosen", async () => {
  const { container } = await mount(fixture("single"), "spi", null);
  const line = container.querySelector(".security-repos-clean");
  expect(line?.textContent).toBe(
    "Nothing open in shipped SPI code: entitlements, legal, schema, file, storage, indexer and 8 more",
  );
  await click(line?.querySelector("button"));
  expect(line?.textContent).toMatch(/: entitlements, .*, osdu-spi, osdu-spi-stack$/);
});
