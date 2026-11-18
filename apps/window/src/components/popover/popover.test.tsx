// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type EvidenceRoute,
  openEvidence,
  openSelection,
  parseRoute,
  setOpenSelection,
} from "../../app/navigation.js";
import { installSpi } from "../../test-utils/harness.js";
import type { OpenedContent } from "../opened-body/content.js";
import { Popover } from "./Popover.js";
import { placePopover } from "./place.js";

it.each([
  ["hangs under the anchor", { top: 100, bottom: 130, left: 40 }, 200, { top: 136, left: 40 }],
  ["flips above near the foot", { top: 700, bottom: 730, left: 40 }, 200, { top: 494, left: 40 }],
  [
    "keeps the roomier side, fitted, when neither fits",
    { top: 300, bottom: 330, left: 40 },
    600,
    { top: 336, left: 40, maxHeight: 452 },
  ],
  [
    "shifts left to stay inside the right margin",
    { top: 100, bottom: 130, left: 900 },
    200,
    { top: 136, left: 568 },
  ],
  [
    "stays inside the window when its anchor scrolls above it",
    { top: -80, bottom: -50, left: 40 },
    200,
    { top: 12, left: 40 },
  ],
  [
    "stays inside the window when its anchor scrolls below it",
    { top: 1100, bottom: 1130, left: 40 },
    200,
    { top: 588, left: 40 },
  ],
  [
    "fits the window's height when its anchor is above it and it is taller",
    { top: -80, bottom: -50, left: 40 },
    1000,
    { top: 12, left: 40, maxHeight: 776 },
  ],
] as const)("%s", (_name, anchor, height, expected) => {
  expect(placePopover(anchor, { width: 420, height }, { width: 1000, height: 800 })).toMatchObject(
    expected,
  );
});

const content: OpenedContent = {
  title: "legal · Main",
  place: { label: "Forks", destination: { kind: "today", tab: "forks" } },
  subject: { kind: "item", id: "gate2:legal" },
  cause: "Nothing waits here.",
};
const selection = { kind: "cell", id: "legal:main" };

let harness: ReturnType<typeof installSpi>;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  harness = installSpi();
  window.location.hash = "#today";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  setOpenSelection(null);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  setOpenSelection(null);
  harness.restore();
});

function Harness({ onOpen }: { onOpen?: () => void }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(true);
  const close = () => {
    setOpen(false);
    setOpenSelection(null);
  };
  return (
    <>
      <button type="button" ref={setAnchor} onClick={() => setOpen(!open)}>
        Cell
      </button>
      <button type="button" className="other" onClick={onOpen}>
        Other
      </button>
      {open && anchor && (
        <Popover anchor={anchor} selection={selection} content={content} onClose={close} />
      )}
    </>
  );
}

const popover = () => container.querySelector<HTMLElement>(".popover");
const anchor = () => container.querySelector<HTMLButtonElement>("button");

it("takes focus in, registers its selection and subject, and hands focus back on Escape", async () => {
  const sheet = vi.fn();
  window.addEventListener("keydown", sheet);
  try {
    await act(async () => root.render(<Harness />));
    expect(popover()?.getAttribute("role")).toBe("dialog");
    expect(popover()?.getAttribute("aria-label")).toBe("legal · Main");
    expect(popover()?.contains(document.activeElement)).toBe(true);
    expect(openSelection()).toMatchObject(selection);
    openEvidence();
    const route = parseRoute(window.location.hash) as EvidenceRoute;
    expect(route.selection).toEqual(content.subject);
    expect(route.open).toEqual(selection);
    window.location.hash = "#today";
    setOpenSelection(selection, content.subject);
    await act(async () =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    expect(popover()).toBeNull();
    expect(sheet).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(anchor());
  } finally {
    window.removeEventListener("keydown", sheet);
  }
});

it("closes on a click outside, but not on its anchor or inside itself", async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => popover()?.querySelector("p")?.click());
  expect(popover()).not.toBeNull();
  await act(async () => document.body.click());
  expect(popover()).toBeNull();
  expect(openSelection()).toBeNull();
});

it.each([
  ["a control that acts on it", "<button data-keeps-popover></button>"],
  ["a button inside one", "<div data-keeps-popover><button></button></div>"],
])("stays open on a click on %s, and closes on any other click outside", async (_name, html) => {
  const chrome = document.createElement("div");
  chrome.innerHTML = html;
  document.body.append(chrome);
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => chrome.querySelector("button")?.click());
    expect(popover()).not.toBeNull();
    await act(async () => chrome.click());
    expect(popover()).toBeNull();
  } finally {
    chrome.remove();
  }
});

it("stays open when the click outside opened something else", async () => {
  await act(async () =>
    root.render(<Harness onOpen={() => setOpenSelection({ kind: "item", id: "halt:indexer" })} />),
  );
  await act(async () => container.querySelector<HTMLButtonElement>(".other")?.click());
  expect(popover()).not.toBeNull();
  expect(openSelection()?.id).toBe("halt:indexer");
});

it("closes from its close button", async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => container.querySelector<HTMLButtonElement>(".popover-close")?.click());
  expect(popover()).toBeNull();
  expect(document.activeElement).toBe(anchor());
});
