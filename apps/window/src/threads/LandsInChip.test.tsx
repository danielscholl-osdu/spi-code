// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stubActEnvironment } from "../test-utils/harness.js";
import { LandsInChip } from "./LandsInChip.js";

let root: Root;
let host: HTMLDivElement;
let restoreAct: () => void;

beforeEach(() => {
  restoreAct = stubActEnvironment();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  restoreAct();
});

it("offers the settled service destinations and chooses one", () => {
  const onChange = vi.fn();
  act(() => root.render(<LandsInChip value="asking" scope="service" onChange={onChange} />));
  const chip = host.querySelector<HTMLButtonElement>("[aria-label^='Lands in:']");
  if (!chip) throw new Error("Missing Lands in chip");
  act(() => chip.click());
  const labels = [...host.querySelectorAll("[aria-label='Lands in'] button")].map(
    (button) => button.textContent,
  );
  expect(labels).toEqual([
    "Asking · changes nothing",
    "Fork · main",
    "Fork · fork_integration",
    "Upstream",
  ]);
  act(() => (host.querySelectorAll("[aria-label='Lands in'] button")[2] as HTMLElement).click());
  expect(onChange).toHaveBeenCalledWith("fork-integration");
});

it("keeps a host failure visible beside the chip", () => {
  act(() =>
    root.render(
      <LandsInChip
        value="asking"
        scope="template"
        onChange={() => {}}
        notice="Branch spi/other is already held by thread other."
      />,
    ),
  );
  expect(host.querySelector("[role='status']")?.textContent).toContain("held by thread");
});

it("limits Template, Environment and Program to their settled destinations", () => {
  const menus = (scope: "template" | "environment" | "program") => {
    act(() =>
      root.render(<LandsInChip key={scope} value="asking" scope={scope} onChange={() => {}} />),
    );
    const chip = host.querySelector<HTMLButtonElement>("[aria-label^='Lands in:']");
    act(() => chip?.click());
    return [...host.querySelectorAll("[aria-label='Lands in'] button")].map(
      (button) => button.textContent,
    );
  };
  expect(menus("template")).toEqual(["Asking · changes nothing", "Fork · main"]);
  expect(menus("environment")).toEqual(["Asking · changes nothing", "Fork · main"]);
  expect(menus("program")).toEqual(["Asking · changes nothing"]);
});
