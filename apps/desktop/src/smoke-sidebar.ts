// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { AssertionError } from "node:assert";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserWindow } from "electron";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A status mark, word or count a sidebar row draws: its class, its words and its box. */
export interface SidebarMark {
  kind: string;
  text: string;
  box: Box;
}

export interface SidebarRow {
  row: string;
  group: "fixed" | "pinned";
  rest: SidebarMark[];
  hover: SidebarMark[];
}

const near = (a: number, b: number) => Math.abs(a - b) <= 0.5;
const sameBox = (a: Box, b: Box) =>
  near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);
const formatBox = ({ x, y, width, height }: Box) => `${x},${y} ${width}x${height}`;

/**
 * Hovering a Pinned or fixed row adds only its background and grip: every mark or word drawn at
 * rest is drawn with the same box, and a row that draws none at rest draws none.
 */
export function assertSidebarHover(rows: readonly SidebarRow[]): void {
  assert(
    rows.some(({ group }) => group === "fixed") && rows.some(({ group }) => group === "pinned"),
    "Sidebar hover needs fixed and Pinned rows",
  );
  assert(
    rows.some(({ group, rest }) => group === "pinned" && rest.length > 0),
    "Sidebar hover needs a Pinned row that draws a mark or word",
  );
  assert(
    rows.some(({ group, rest }) => group === "pinned" && rest.length === 0),
    "Sidebar hover needs a Pinned row that draws none",
  );
  const lines: string[] = [];
  for (const { row, rest, hover } of rows) {
    const left = [...hover];
    for (const mark of rest) {
      const at = left.findIndex(({ kind, text }) => kind === mark.kind && text === mark.text);
      const [found] = at < 0 ? [] : left.splice(at, 1);
      if (!found) lines.push(`${row} hides ${mark.kind} "${mark.text}"`);
      else if (!sameBox(mark.box, found.box))
        lines.push(
          `${row} moves ${mark.kind} "${mark.text}" from ${formatBox(mark.box)} to ${formatBox(found.box)}`,
        );
    }
    for (const mark of left) lines.push(`${row} draws ${mark.kind} "${mark.text}" only on hover`);
  }
  if (lines.length > 0) throw new AssertionError({ message: `Sidebar hover: ${lines.join("; ")}` });
}

/** Runs in the renderer: each sidebar row with the marks and words it draws now. */
function sidebarMarks(only: string | null) {
  const box = (element: Element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  };
  return [...document.querySelectorAll("#app-sidebar [data-sidebar-row]")]
    .filter((button) => button.getAttribute("data-sidebar-row") !== "settings")
    .filter((button) => only === null || button.getAttribute("data-sidebar-row") === only)
    .map((button) => ({
      row: button.getAttribute("data-sidebar-row") ?? "",
      group: button.closest("[data-group=pinned]") ? "pinned" : "fixed",
      marks: [...button.querySelectorAll(".sidebar-mark, .sidebar-pip")]
        .filter((mark) => {
          const { width, height } = mark.getBoundingClientRect();
          return (
            width > 0 &&
            height > 0 &&
            mark.checkVisibility({ opacityProperty: true, visibilityProperty: true })
          );
        })
        .map((mark) => ({
          kind: mark.classList[0] ?? "",
          text: mark.textContent?.trim() || (mark.getAttribute("data-mark") ?? ""),
          box: box(mark),
        })),
    }));
}

type Measured = { row: string; group: SidebarRow["group"]; marks: SidebarMark[] }[];

const PINS_KEY = "spi-code.sidebar.pins.v3";
const HOVERED = "entitlements";
/** A blocked service, two waiting ones, Upstream, and Releases and Security. */
const PINS = [
  "place:upstream",
  HOVERED,
  "legal",
  "schema",
  "place:releases",
  "place:security",
] as const;
/** The old hover hide, without the unpin button it once made room for. */
const OLD_HOVER_HIDE = ".pin-item:hover .sidebar-mark { visibility: hidden; }";

/**
 * The sidebar with stored pins: the hover rule on every fixed and Pinned row, its broken-rule
 * proof in light, and captures at rest, with a Pinned row hovered, and with its menu open.
 */
export async function captureSidebarPins(
  window: BrowserWindow,
  output: string,
  appearance: "light" | "dark",
  rendered: (condition: string) => Promise<void>,
): Promise<void> {
  const js = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source);
  const debug = window.webContents.debugger;
  const key = JSON.stringify(PINS_KEY);
  const hoveredRow = JSON.stringify(`service/${HOVERED}`);
  const saved = await js<string | null>(`localStorage.getItem(${key})`);
  const store = (value: string | null) =>
    js(`{
      const value = ${JSON.stringify(value)};
      value === null ? localStorage.removeItem(${key}) : localStorage.setItem(${key}, value);
      window.dispatchEvent(new StorageEvent("storage", { key: ${key} }));
    }`);
  let forced: number[] = [];
  const unforce = async () => {
    await Promise.all(
      forced.map((nodeId) =>
        debug.sendCommand("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] }),
      ),
    );
    forced = [];
    await js(
      'document.querySelectorAll("[data-smoke-hover]").forEach((item) => item.removeAttribute("data-smoke-hover"))',
    );
  };
  /** Hovers a row as a pointer does: the row and every element it sits in. */
  const hover = async (row: string) => {
    await unforce();
    await js(`{
      let item = document.querySelector('#app-sidebar [data-sidebar-row="' + ${JSON.stringify(row)} + '"]');
      for (; item && item !== document.documentElement; item = item.parentElement) item.setAttribute("data-smoke-hover", "");
    }`);
    const { root }: { root: { nodeId: number } } = await debug.sendCommand("DOM.getDocument", {
      depth: 0,
    });
    const found: { nodeIds: number[] } = await debug.sendCommand("DOM.querySelectorAll", {
      nodeId: root.nodeId,
      selector: "[data-smoke-hover]",
    });
    forced = found.nodeIds;
    await Promise.all(
      forced.map((nodeId) =>
        debug.sendCommand("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] }),
      ),
    );
  };
  const marks = (row: string | null) =>
    js<Measured>(`(${sidebarMarks.toString()})(${JSON.stringify(row)})`);
  const measure = async (): Promise<SidebarRow[]> => {
    await unforce();
    const rows: SidebarRow[] = [];
    for (const { row, group, marks: rest } of await marks(null)) {
      await hover(row);
      rows.push({ row, group, rest, hover: (await marks(row))[0]?.marks ?? [] });
    }
    await unforce();
    return rows;
  };
  const sidebarBox = () =>
    js<Box>(`(() => {
      const rect = document.querySelector("#app-sidebar[data-state=expanded]").getBoundingClientRect();
      return { x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
    })()`);
  const capture = async (file: string, box: Box) =>
    writeFileSync(join(output, file), (await window.webContents.capturePage(box)).toPNG());

  await debug.sendCommand("DOM.enable");
  await debug.sendCommand("CSS.enable");
  await store(JSON.stringify(PINS));
  try {
    await rendered(
      `${JSON.stringify(PINS.map((pin) => (pin.startsWith("place:") ? pin.slice(6) : `service/${pin}`)))}.every((row) => document.querySelector('#app-sidebar [data-group=pinned] [data-sidebar-row="' + row + '"]')) && document.querySelector('[data-sidebar-row=${hoveredRow}] .sidebar-mark')`,
    );
    const rows = await measure();
    assertSidebarHover(rows);
    console.log(
      `Packaged sidebar hover ${appearance}: ${rows.length} rows, ${rows.filter(({ rest }) => rest.length > 0).length} drawing a mark or word, each the same when hovered`,
    );
    let rejected: string | undefined;
    if (appearance === "light") {
      await js(`{
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(${JSON.stringify(OLD_HOVER_HIDE)});
        window.__smokeHoverHide = sheet;
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }`);
      try {
        assertSidebarHover(await measure());
        assert.fail("The old sidebar hover hide passed");
      } catch (error) {
        if (!(error instanceof AssertionError) || !/^Sidebar hover: .* hides /.test(error.message))
          throw error;
        rejected = error.message;
        console.log(`Packaged broken-rule proof rejected: ${error.message}`);
      } finally {
        await js(`{
          document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== window.__smokeHoverHide);
          delete window.__smokeHoverHide;
        }`);
      }
      assert(rejected, "Missing packaged sidebar hover broken-rule proof");
      assertSidebarHover(await measure());
    }
    writeFileSync(
      join(output, `sidebar-hover-${appearance}.json`),
      `${JSON.stringify({ rows, ...(rejected ? { rejected } : {}) }, null, 2)}\n`,
    );

    const sidebar = await sidebarBox();
    await rendered("true");
    await capture(`sidebar-pins-rest-${appearance}.png`, sidebar);
    await hover(`service/${HOVERED}`);
    await rendered("true");
    await capture(`sidebar-pins-hover-${appearance}.png`, sidebar);
    await js(`{
      const button = document.querySelector('#app-sidebar [data-sidebar-row=${hoveredRow}]');
      const box = button.getBoundingClientRect();
      button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + 24, clientY: box.bottom }));
    }`);
    await rendered(`document.querySelector('[data-pin-menu="${HOVERED}"]')`);
    const menu = await js<Box>(`(() => {
      const sidebar = document.querySelector("#app-sidebar[data-state=expanded]").getBoundingClientRect();
      const menu = document.querySelector('[data-pin-menu="${HOVERED}"]').getBoundingClientRect();
      const x = Math.floor(Math.min(sidebar.x, menu.x));
      const y = Math.floor(Math.min(sidebar.y, menu.y));
      return { x, y, width: Math.ceil(Math.max(sidebar.right, menu.right + 8)) - x, height: Math.ceil(Math.max(sidebar.bottom, menu.bottom + 8)) - y };
    })()`);
    await capture(`sidebar-pins-menu-${appearance}.png`, menu);
    await js(
      `document.querySelector('[data-pin-menu="${HOVERED}"]').dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
    );
    await rendered(`!document.querySelector('[data-pin-menu="${HOVERED}"]')`);
    writeFileSync(
      join(output, `sidebar-pins-${appearance}.html`),
      `<!doctype html><meta charset="utf-8"><title>Sidebar pins</title><style>body{font:14px system-ui;padding:24px}figure{margin:24px 0}figcaption{margin-bottom:8px}</style><h1>Sidebar pins / ${appearance}</h1><p>Design: epic spicode-1l9 and prototype spicode-e2z (proto-pins-sidebar.png). Today, Line, Environment and Template are the fixed block; Pinned holds Upstream, entitlements (blocked, a filled count), legal and schema (waiting, an outlined count), Releases and Security. Hovering adds only the background and the grip.</p><figure><figcaption>At rest</figcaption><img src="sidebar-pins-rest-${appearance}.png" alt="Sidebar at rest"></figure><figure><figcaption>${HOVERED} hovered</figcaption><img src="sidebar-pins-hover-${appearance}.png" alt="Sidebar with a Pinned row hovered"></figure><figure><figcaption>${HOVERED} menu open</figcaption><img src="sidebar-pins-menu-${appearance}.png" alt="Sidebar with a Pinned row's menu open"></figure>`,
    );
  } finally {
    await unforce();
    await store(saved);
    await debug.sendCommand("CSS.disable");
    await debug.sendCommand("DOM.disable");
  }
}
