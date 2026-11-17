// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert, { AssertionError } from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import type { SmokeGeometry } from "./smoke-geometry.js";

const PINS_KEY = "spi-code.sidebar.pins.v3";
const STATES = [
  { route: "upstream", place: "Upstream", pinned: true },
  { route: "service/partition", place: "partition", pinned: false },
] as const;

/** Each broken rule the pin-end geometry must reject, and the width it is shown at. */
const BROKEN = [
  {
    width: 740,
    css: "@container (width < 800px) { .centre-end > .pin-control { display: none; } }",
    rejects: /^Top-row pin control is not drawn$/,
    what: "the old under-800 px hide",
  },
  {
    width: 1440,
    css: ".centre-row { grid-template-columns: max-content max-content !important; }",
    rejects: /^Top-row pin control ends at /,
    what: "the control beside the title",
  },
] as const;

/** The pin-end geometry in the renderer, for the shell's own measure. */
export const PIN_END_PROBE = `(() => {
  const rect = item => item ? (({ x, y, width, height }) => ({ x, y, width, height }))(item.getBoundingClientRect()) : null;
  const bar = document.querySelector(".centre-bar").getBoundingClientRect();
  const end = document.querySelector(".centre-end");
  const pin = end.querySelector(":scope > .pin-control");
  const overlay = navigator.windowControlsOverlay;
  const area = document.querySelector(".shell").dataset.windowControls === "overlay" && overlay?.visible ? overlay.getTitlebarAreaRect() : null;
  return { rule: "pin-end", end: bar.right - parseFloat(getComputedStyle(end).paddingRight),
    clear: area ? area.x + area.width : innerWidth,
    title: rect(document.querySelector(".centre-title h1")),
    pin: pin && getComputedStyle(pin).display !== "none" && pin.getBoundingClientRect().width > 0 ? rect(pin) : null,
    toggle: rect(end.querySelector("[aria-label='Toggle right panel']")) };
})()`;

/**
 * The top row's pin control on a pinned place and an unpinned service: the pin-end geometry
 * at each width, captures at 1440 and 740 px (and the pinned control
 * hovered), and the two broken rules rejected in light.
 */
export async function captureTopRowPins(
  window: BrowserWindow,
  output: string,
  width: number,
  appearance: "light" | "dark",
  measure: () => Promise<SmokeGeometry>,
  rendered: (condition: string) => Promise<void>,
): Promise<void> {
  const js = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source);
  const key = JSON.stringify(PINS_KEY);
  const saved = await js<string | null>(`localStorage.getItem(${key})`);
  const store = (value: string | null) =>
    js(`{
      const value = ${JSON.stringify(value)};
      value === null ? localStorage.removeItem(${key}) : localStorage.setItem(${key}, value);
      window.dispatchEvent(new StorageEvent("storage", { key: ${key} }));
    }`);
  const captured = width === 1440 || width === 740;
  const measured: { state: string; geometry: SmokeGeometry }[] = [];
  const figures: string[] = [];
  let rejected: string[] = [];
  await store(JSON.stringify(["place:upstream"]));
  try {
    for (const { route, place, pinned } of STATES) {
      await js(`location.hash = ${JSON.stringify(`#${route}`)}`);
      await rendered(
        `document.querySelector("[data-place]")?.textContent === ${JSON.stringify(place)} && document.querySelector(".centre-end > .pin-control[data-pinned=${pinned}]")`,
      );
      {
        assert.equal(
          await js(
            `document.querySelectorAll("#app-right-panel, [aria-controls=app-right-panel]").length`,
          ),
          0,
          "Panel or toggle outside a thread",
        );
        await rendered("true");
        const state = `${pinned ? "pinned" : "unpinned"}`;
        const geometry = await measure();
        measured.push({ state, geometry });
        if (captured) {
          const file = `top-row-${state}-${width}-${appearance}.png`;
          writeFileSync(
            join(output, file),
            (await window.webContents.capturePage({ x: 0, y: 0, width, height: 44 })).toPNG(),
          );
          figures.push(`<figure><figcaption>${state}</figcaption><img src="${file}"></figure>`);
          if (pinned) figures.push(await captureHover(window, output, width, appearance, rendered));
        }
      }
    }
    if (appearance === "light") rejected = await rejectBroken(window, width, measure, rendered);
  } finally {
    await store(saved);
  }
  console.log(
    `Packaged top-row pin ${width}/${appearance}: ${measured.map(({ state }) => state).join(", ")}${rejected.length ? `; rejected ${rejected.join("; ")}` : ""}`,
  );
  writeFileSync(
    join(output, `top-row-pins-${width}-${appearance}.json`),
    `${JSON.stringify({ measured, rejected }, null, 2)}\n`,
  );
  if (captured)
    writeFileSync(
      join(output, `top-row-pins-${width}-${appearance}.html`),
      `<!doctype html><meta charset="utf-8"><title>Top-row pin control</title><style>body{font:14px system-ui;padding:24px}figure{margin:16px 0}img{max-width:100%;border:1px solid #888}</style><h1>Top-row pin control / ${width} px / ${appearance}</h1><p>Design: epic spicode-1l9, PS-11 and PS-17. Upstream pinned (filled), partition unpinned (hollow); the control sits at the end of the top row.</p>${figures.join("")}`,
    );
}

/** The pinned control under a forced hover, which must show pin-off in place of the filled pin. */
async function captureHover(
  window: BrowserWindow,
  output: string,
  width: number,
  appearance: "light" | "dark",
  rendered: (condition: string) => Promise<void>,
): Promise<string> {
  const debug = window.webContents.debugger;
  await debug.sendCommand("DOM.enable");
  await debug.sendCommand("CSS.enable");
  const { root }: { root: { nodeId: number } } = await debug.sendCommand("DOM.getDocument", {
    depth: 0,
  });
  const { nodeId }: { nodeId: number } = await debug.sendCommand("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: ".centre-end > .pin-control[data-pinned=true]",
  });
  await debug.sendCommand("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
  try {
    await rendered(
      `getComputedStyle(document.querySelector(".centre-end > .pin-control[data-pinned=true] .pin-control-off")).visibility === "visible"`,
    ).catch(() => {});
    const shown = await window.webContents.executeJavaScript(`(() => {
      const pin = document.querySelector(".centre-end > .pin-control[data-pinned=true]");
      const seen = (name) => getComputedStyle(pin.querySelector(name)).visibility === "visible";
      return { pin: seen(".pin-control-pin"), off: seen(".pin-control-off") };
    })()`);
    assert.deepEqual(
      shown,
      { pin: false, off: true },
      "Hovered pinned control does not show pin-off",
    );
    const file = `top-row-pinned-hover-${width}-${appearance}.png`;
    writeFileSync(
      join(output, file),
      (await window.webContents.capturePage({ x: 0, y: 0, width, height: 44 })).toPNG(),
    );
    return `<figure><figcaption>pinned-hover (pin-off)</figcaption><img src="${file}"></figure>`;
  } finally {
    await debug.sendCommand("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
    await debug.sendCommand("CSS.disable");
    await debug.sendCommand("DOM.disable");
  }
}

async function rejectBroken(
  window: BrowserWindow,
  width: number,
  measure: () => Promise<SmokeGeometry>,
  rendered: (condition: string) => Promise<void>,
): Promise<string[]> {
  const rejected: string[] = [];
  for (const proof of BROKEN.filter((proof) => proof.width === width)) {
    await window.webContents.executeJavaScript(`{
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(${JSON.stringify(proof.css)});
      window.__smokePinBreak = sheet;
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    }`);
    await rendered("true");
    try {
      await measure();
      assert.fail(`The top row passed with ${proof.what}`);
    } catch (error) {
      if (!(error instanceof AssertionError) || !proof.rejects.test(error.message)) throw error;
      console.log(`Packaged broken-rule proof rejected: ${error.message}`);
      rejected.push(`${proof.what}: ${error.message}`);
    } finally {
      await window.webContents.executeJavaScript(`{
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== window.__smokePinBreak);
        delete window.__smokePinBreak;
      }`);
      await rendered("true");
    }
    await measure();
  }
  return rejected;
}
