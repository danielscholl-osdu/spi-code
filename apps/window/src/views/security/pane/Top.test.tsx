// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type SecurityPane as Pane, SecurityPaneSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { readGenerated } from "../../../../../../scripts/watch-generated.mjs";
import { stubActEnvironment } from "../../../test-utils/harness.js";
import { SecurityPane } from "./Pane.js";

const fixture = (name: string): Pane =>
  SecurityPaneSchema.parse(JSON.parse(readGenerated(`security/${name}.json`)));
const cleanups: (() => Promise<void>)[] = [];

async function mount(pane: Pane) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<SecurityPane pane={pane} />));
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return container;
}

let restoreAct: () => void;
beforeAll(() => {
  restoreAct = stubActEnvironment();
});
afterAll(() => restoreAct());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const pressed = (container: HTMLElement) =>
  [...container.querySelectorAll(".security-fig-name")].map((b) => b.getAttribute("aria-pressed"));
const row = (container: HTMLElement, lane: string) => {
  const found = container.querySelector<HTMLElement>(`.security-fig-row[data-lane="${lane}"]`);
  if (!found) throw new Error(`No ${lane} row`);
  return found;
};
const click = (element: Element | null | undefined) =>
  act(async () => (element as HTMLElement).click());

it("opens on the page's lane, chooses a lane by its name, and opens a rule by its own block", async () => {
  const pane = fixture("1116");
  const container = await mount(pane);
  expect(pressed(container)).toEqual(["true", "false", "false"]);

  await click(row(container, "tests").querySelector(".security-fig-name"));
  expect(pressed(container)).toEqual(["false", "false", "true"]);

  const [first] = pane.lanes[1]?.figure.blocks ?? [];
  const block = row(container, "upstream").querySelector(".security-fig-block");
  expect(block?.getAttribute("aria-label")).toContain(
    "User-controlled data in arithmetic expression",
  );
  await click(block);
  expect(pressed(container)).toEqual(["false", "true", "false"]);
  expect(block?.hasAttribute("data-selected")).toBe(true);
  expect(first?.rules).toHaveLength(1);

  await click(row(container, "tests").querySelector(".security-fig-block[data-grouped]"));
  expect(pressed(container)).toEqual(["false", "false", "true"]);
  expect(container.querySelector(".security-fig-block[data-selected]")).toBeNull();

  const controls = [...container.querySelectorAll(".security-fig-name, .security-fig-block")];
  expect(controls.every((c) => c instanceof HTMLButtonElement && c.type === "button")).toBe(true);
});

it("draws a block per core block, with only the counts core wrote", async () => {
  for (const name of ["1116", "partial", "clean", "single"]) {
    const pane = fixture(name);
    const container = await mount(pane);
    for (const lane of pane.lanes) {
      const drawn = [...row(container, lane.id).querySelectorAll(".security-fig-count")];
      expect(drawn.map((c) => c.textContent)).toEqual(
        lane.figure.blocks.map((b) => `${b.alerts.atLeast ? "≥" : ""}${b.alerts.n}`),
      );
    }
  }
});

it("ends every bar in a stub and links the banner to Evidence while a list was not read", async () => {
  const container = await mount(fixture("partial"));
  expect(container.querySelectorAll(".security-fig-stub")).toHaveLength(3);
  expect(container.querySelector(".security-banner a")?.getAttribute("href")).toBe(
    "#evidence?from=security",
  );
  expect(container.querySelector(".security-fig-legend")?.textContent).toContain("Not read");

  const read = await mount(fixture("1116"));
  expect(read.querySelectorAll(".security-fig-stub, .security-banner")).toHaveLength(0);
});

it("says Nothing open once in a lane with nothing, and opens on the first shipped lane with alerts", async () => {
  const container = await mount(fixture("clean"));
  const spi = row(container, "spi");
  expect(spi.querySelectorAll(".security-fig-block")).toHaveLength(0);
  expect(spi.textContent?.match(/Nothing open/g)).toHaveLength(1);
  expect(pressed(container)).toEqual(["false", "true", "false"]);
});
