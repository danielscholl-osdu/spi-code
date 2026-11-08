// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PaneSeparator, type PaneSeparatorProps } from "./PaneSeparator.js";

const css = ["theme/tokens.css", "components/resize/pane-separator.css"]
  .map((file) => readFileSync(`apps/window/src/${file}`, "utf8"))
  .join("\n");

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

type Options = Partial<Omit<PaneSeparatorProps, "onResize" | "onResizeEnd">>;

function Pane({
  options,
  live,
  finished,
}: {
  options: Options;
  live: number[];
  finished: number[];
}) {
  const [width, setWidth] = useState(options.width ?? 232);
  return (
    <div style={{ position: "relative", width }}>
      <PaneSeparator
        label="Resize sidebar"
        edge="right"
        min={200}
        max={320}
        defaultWidth={232}
        {...options}
        width={width}
        onResize={(next) => {
          live.push(next);
          setWidth(next);
        }}
        onResizeEnd={(next) => {
          finished.push(next);
          setWidth(next);
        }}
      />
    </div>
  );
}

async function mount(options: Options = {}) {
  const live: number[] = [];
  const finished: number[] = [];
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (next: Options) =>
    act(async () => root.render(<Pane options={next} live={live} finished={finished} />));
  await render(options);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
    style.remove();
  });
  const separator = container.querySelector<HTMLElement>('[role="separator"]');
  const line = container.querySelector<HTMLElement>(".pane-separator-line");
  if (!separator || !line) throw new Error("Missing separator");
  return { separator, line, live, finished, render };
}

async function pointer(target: HTMLElement, type: string, clientX: number) {
  await act(async () => {
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX }),
    );
  });
}

async function frame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

async function drag(target: HTMLElement, from: number, to: number) {
  await pointer(target, "pointerdown", from);
  await pointer(target, "pointermove", to);
  await frame();
  await pointer(target, "pointerup", to);
}

async function key(target: HTMLElement, name: string, shiftKey = false) {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: name, shiftKey }),
    );
  });
}

function values(separator: HTMLElement) {
  return ["aria-valuenow", "aria-valuemin", "aria-valuemax"].map((name) =>
    separator.getAttribute(name),
  );
}

function accent(line: HTMLElement): boolean {
  const token = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  return getComputedStyle(line).backgroundColor === token;
}

it("announces a focusable vertical separator with its width and bounds", async () => {
  const { separator } = await mount({ controls: "sidebar" });
  expect(separator.tabIndex).toBe(0);
  expect(separator.getAttribute("aria-orientation")).toBe("vertical");
  expect(separator.getAttribute("aria-label")).toBe("Resize sidebar");
  expect(separator.getAttribute("aria-controls")).toBe("sidebar");
  expect(values(separator)).toEqual(["232", "200", "320"]);
});

it("announces the stop as the maximum when it is narrower than the pane's maximum", async () => {
  const { separator } = await mount({ edge: "left", width: 360, min: 280, max: 792, stop: 600 });
  expect(values(separator)).toEqual(["360", "280", "600"]);
});

it("announces a width above the stop as the stop", async () => {
  const { separator } = await mount({ width: 300, stop: 250 });
  expect(values(separator)).toEqual(["250", "200", "250"]);
});

it("re-clamps a stationary drag when the stop shrinks", async () => {
  const { separator, live, finished, render } = await mount();
  await pointer(separator, "pointerdown", 100);
  await pointer(separator, "pointermove", 160);
  await frame();
  expect(separator.getAttribute("aria-valuenow")).toBe("292");
  await render({ stop: 250 });
  expect(values(separator)).toEqual(["250", "200", "250"]);
  expect(live).toEqual([292, 250]);
  await pointer(separator, "pointerup", 160);
  expect(finished).toEqual([250]);
});

it("finishes an unmoved press at the stop when the stop shrinks under it", async () => {
  const { separator, finished, render } = await mount({ width: 300 });
  await pointer(separator, "pointerdown", 100);
  await render({ width: 300, stop: 250 });
  expect(separator.getAttribute("aria-valuenow")).toBe("250");
  await pointer(separator, "pointerup", 100);
  expect(finished).toEqual([250]);
});

it("reflows live while dragging and reports the width the drag ends on", async () => {
  const { separator, live, finished } = await mount();
  await pointer(separator, "pointerdown", 100);
  await pointer(separator, "pointermove", 140);
  await frame();
  expect(live).toEqual([272]);
  expect(finished).toEqual([]);
  expect(separator.getAttribute("aria-valuenow")).toBe("272");
  expect(document.body.style.cursor).toBe("col-resize");
  await pointer(separator, "pointermove", 160);
  await frame();
  await pointer(separator, "pointerup", 160);
  expect(live).toEqual([272, 292]);
  expect(finished).toEqual([292]);
  expect(separator.getAttribute("aria-valuenow")).toBe("292");
  expect(document.body.style.cursor).toBe("");
});

it("grows a left-edge pane when dragged to the left", async () => {
  const { separator, finished } = await mount({ edge: "left", width: 360, min: 280, max: 792 });
  await drag(separator, 500, 420);
  expect(finished).toEqual([440]);
});

it("stops a drag at the caller's stop and at the minimum", async () => {
  const wide = await mount({ edge: "left", width: 360, min: 280, max: 792, stop: 400 });
  await drag(wide.separator, 500, 100);
  expect(wide.finished).toEqual([400]);
  await drag(wide.separator, 100, 900);
  expect(wide.finished).toEqual([400, 280]);
});

it("treats a press without movement as no resize", async () => {
  const { separator, live, finished } = await mount();
  await drag(separator, 100, 102);
  expect(live).toEqual([]);
  expect(finished).toEqual([]);
});

it("steps 16 px on an arrow and 64 px on Shift with an arrow, each a finished width", async () => {
  const { separator, finished } = await mount();
  await key(separator, "ArrowRight");
  await key(separator, "ArrowRight", true);
  await key(separator, "ArrowLeft");
  await key(separator, "ArrowLeft", true);
  expect(finished).toEqual([248, 312, 296, 232]);
  expect(separator.getAttribute("aria-valuenow")).toBe("232");
});

it("steps a left-edge pane wider on ArrowLeft", async () => {
  const { separator, finished } = await mount({ edge: "left", width: 360, min: 280, max: 792 });
  await key(separator, "ArrowLeft");
  await key(separator, "ArrowRight", true);
  expect(finished).toEqual([376, 312]);
});

it("holds arrow steps within the stop and the minimum", async () => {
  const { separator, finished } = await mount({ width: 296, stop: 300 });
  await key(separator, "ArrowRight");
  await key(separator, "ArrowRight");
  expect(finished).toEqual([300]);
  await key(separator, "ArrowLeft", true);
  await key(separator, "ArrowLeft", true);
  await key(separator, "ArrowLeft");
  expect(finished).toEqual([300, 236, 200]);
});

it("ignores other keys", async () => {
  const { separator, finished } = await mount();
  for (const name of ["Home", "End", "ArrowUp", "Enter"]) await key(separator, name);
  expect(finished).toEqual([]);
});

it("returns to the default width on double-click", async () => {
  const { separator, finished } = await mount({ width: 300 });
  await act(async () => {
    separator.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  expect(finished).toEqual([232]);
  expect(separator.getAttribute("aria-valuenow")).toBe("232");
});

it("reports the default on double-click and announces it within the stop", async () => {
  const { separator, finished } = await mount({ width: 200, stop: 210 });
  await act(async () => {
    separator.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  expect(finished).toEqual([232]);
  expect(values(separator)).toEqual(["210", "200", "210"]);
});

it("turns the divider accent on hover and keyboard focus", async () => {
  const { separator, line } = await mount();
  expect(accent(line)).toBe(false);
  await act(async () => {
    separator.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerId: 1 }));
  });
  expect(separator.hasAttribute("data-active")).toBe(true);
  expect(accent(line)).toBe(true);
  await act(async () => {
    separator.dispatchEvent(
      new PointerEvent("pointerout", { bubbles: true, pointerId: 1, relatedTarget: document.body }),
    );
  });
  expect(accent(line)).toBe(false);
  await act(async () => separator.focus());
  expect(accent(line)).toBe(true);
  await act(async () => separator.blur());
  expect(accent(line)).toBe(false);
});

it("keeps the divider accent for the whole drag", async () => {
  const { separator, line } = await mount();
  await pointer(separator, "pointerdown", 100);
  await act(async () => separator.focus());
  expect(separator.hasAttribute("data-dragging")).toBe(true);
  expect(accent(line)).toBe(true);
  await pointer(separator, "pointermove", 140);
  await frame();
  expect(accent(line)).toBe(true);
  await pointer(separator, "pointerup", 140);
  expect(separator.hasAttribute("data-dragging")).toBe(false);
  expect(accent(line)).toBe(false);
});

it("draws an 8 px column-resize target with a 1 px divider line at its centre", async () => {
  const { separator, line } = await mount();
  const target = getComputedStyle(separator);
  const divider = getComputedStyle(line);
  expect(target.width).toBe("8px");
  expect(target.cursor).toBe("col-resize");
  expect(divider.width).toBe("1px");
  expect(Number.parseFloat(divider.left) + Number.parseFloat(divider.width) / 2).toBe(
    Number.parseFloat(target.width) / 2,
  );
});

it("restores the start width when the separator unmounts mid-drag", async () => {
  const { separator, live, finished } = await mount();
  const removed = vi.spyOn(window, "removeEventListener");
  await pointer(separator, "pointerdown", 100);
  await pointer(separator, "pointermove", 150);
  await frame();
  await cleanups.splice(0)[0]?.();
  expect(live).toEqual([282, 232]);
  expect(finished).toEqual([]);
  expect(removed).toHaveBeenCalledWith("blur", expect.any(Function));
  expect(document.body.style.cursor).toBe("");
  removed.mockRestore();
});
