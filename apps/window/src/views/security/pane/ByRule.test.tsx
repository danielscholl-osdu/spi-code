// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type SecurityPane, SecurityPaneSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { readFixture } from "../../../../../../scripts/watch-generated.mjs";
import { ByRule } from "./ByRule.js";
import { INITIAL_STATE, type SecurityActions } from "./state.js";

const pane: SecurityPane = SecurityPaneSchema.parse(
  JSON.parse(readFixture("fixtures/watch/generated/security/1116.json")),
);
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function mount() {
  const lane = pane.lanes.find(({ id }) => id === "spi");
  if (!lane) throw new Error("No SPI lane");
  const actions: SecurityActions = {
    chooseLane: vi.fn(),
    setView: vi.fn(),
    openRule: vi.fn(),
    openRepository: vi.fn(),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(<ByRule pane={pane} lane={lane} state={INITIAL_STATE} actions={actions} />),
  );
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const strip = container.querySelector<HTMLElement>(".security-strip");
  const caption = () => strip?.parentElement?.querySelector("small")?.textContent;
  if (!strip) throw new Error("No strip");
  return { actions, strip, caption, container };
}

const key = async (strip: HTMLElement, name: string) =>
  act(async () => {
    strip.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });

it("steps a strip's repositories with the arrow keys, opens the one named with Enter, and forgets it when focus leaves", async () => {
  const { actions, strip, caption } = await mount();
  const csrf = "spi:code:CodeQL:java/spring-disabled-csrf-protection";
  expect(strip.getAttribute("aria-label")).toMatch(
    /^Disabled Spring CSRF protection by repository: schema 3, /,
  );
  expect(caption()).toBe("12 forks");
  await act(async () => strip.focus());
  await key(strip, "ArrowLeft");
  expect(caption()).toBe("crs-conversion 1");
  await key(strip, "ArrowRight");
  expect(caption()).toBe("crs-conversion 1");
  await key(strip, "ArrowLeft");
  expect(caption()).toBe("crs-catalog 1");
  await key(strip, "Enter");
  expect(actions.openRule).toHaveBeenLastCalledWith(csrf, "crs-catalog");
  await act(async () => strip.blur());
  expect(caption()).toBe("12 forks");
  await act(async () => strip.focus());
  await key(strip, "ArrowRight");
  expect(caption()).toBe("partition 2");
  await key(strip, "ArrowRight");
  expect(caption()).toBe("entitlements 2");
  await act(async () => strip.blur());
  await key(strip, "Enter");
  expect(actions.openRule).toHaveBeenLastCalledWith(csrf, undefined);
});

it("names a pointed tick under its strip and opens the rule with that repository marked", async () => {
  const { actions, strip, caption, container } = await mount();
  const schema = strip.querySelectorAll("i")[3];
  if (!schema) throw new Error("No schema tick");
  await act(async () => schema.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  expect(caption()).toBe("schema 3");
  expect(container.querySelectorAll("i[data-hot]").length).toBeGreaterThan(1);
  await act(async () => schema.click());
  expect(actions.openRule).toHaveBeenLastCalledWith(
    "spi:code:CodeQL:java/spring-disabled-csrf-protection",
    "schema",
  );
  const quiet = strip.querySelectorAll("i")[14];
  await act(async () => quiet?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  expect(caption()).toBe("12 forks");
});
