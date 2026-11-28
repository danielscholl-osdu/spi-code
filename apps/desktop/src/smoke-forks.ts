// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ViewSnapshot } from "@spi-code/contracts";
import { nativeImage } from "electron";
import { assertSmokeImage } from "./smoke-report.js";
import { captureTodayFrame, type TodayCaptureContext } from "./smoke-today.js";

const FIRST_FORK = 'document.querySelector(".forks-scroll tr[data-fork]")';

type Box = { left: number; top: number; right: number; bottom: number };

/** Each fork row wholly in view: its toggle, its name's words, and the rest of its name cell. */
const stickyRowsScript = `(() => {
  const sheet = document.querySelector(".forks-scroll").getBoundingClientRect();
  const pane = document.querySelector(".today-frame").closest(".centre-body > *").getBoundingClientRect();
  const top = Math.max(sheet.top, pane.top), bottom = Math.min(sheet.bottom, pane.bottom);
  const box = ({ left, top, right, bottom }) => ({ left, top, right, bottom });
  return [...document.querySelectorAll(".forks-scroll tr[data-fork]")].flatMap(row => {
    const { top: rowTop, bottom: rowBottom } = row.getBoundingClientRect();
    if (rowTop < top || rowBottom > bottom) return [];
    const cell = row.querySelector(".forks-name-cell");
    const { left, right } = cell.getBoundingClientRect();
    const x = (left + right) / 2;
    if (![rowTop + 1, rowBottom - 1].every(y => row.contains(document.elementFromPoint(x, y)))) return [];
    const words = [...cell.querySelector(".forks-name").children].map(part => part.getBoundingClientRect());
    return [{
      fork: row.dataset.fork,
      toggle: box(row.querySelector(".forks-toggle").getBoundingClientRect()),
      name: box(row.querySelector(".forks-name .today-fork-name").getBoundingClientRect()),
      rest: { left: Math.max(...words.map(({ right }) => right)) + 3, top: rowTop + 3,
        right: cell.getBoundingClientRect().right - 3, bottom: rowBottom - 3 },
    }];
  });
})()`;

/**
 * Rows whose sticky cells the capture does not show as drawn: a toggle or name with no ink, or
 * ink in the empty part of the name cell where a scrolled column shows through.
 */
function stickyFaults(
  image: { width: number; bitmap: Buffer },
  scale: number,
  rows: { fork: string; toggle: Box; name: Box; rest: Box }[],
): string[] {
  const pixels = (box: Box) => {
    const found: number[] = [];
    for (let y = Math.ceil(box.top * scale); y < Math.floor(box.bottom * scale); y++)
      for (let x = Math.ceil(box.left * scale); x < Math.floor(box.right * scale); x++) {
        const at = (y * image.width + x) * 4;
        found.push(
          ((image.bitmap[at] ?? 0) << 16) |
            ((image.bitmap[at + 1] ?? 0) << 8) |
            (image.bitmap[at + 2] ?? 0),
        );
      }
    return found;
  };
  const distance = (a: number, b: number) =>
    Math.abs((a >> 16) - (b >> 16)) +
    Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)) +
    Math.abs((a & 255) - (b & 255));
  return rows.flatMap(({ fork, toggle, name, rest }) => {
    const empty = pixels(rest);
    const counts = new Map<number, number>();
    for (const pixel of empty) counts.set(pixel, (counts.get(pixel) ?? 0) + 1);
    const surface = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
    const ink = (box: Box) => pixels(box).filter((pixel) => distance(pixel, surface) > 90).length;
    return [
      ...(ink(toggle) < 2 ? [`${fork}: toggle not drawn`] : []),
      ...(ink(name) < 8 ? [`${fork}: name not drawn`] : []),
      ...(ink(rest) > 0 ? [`${fork}: ${ink(rest)} pixels of another column in its name cell`] : []),
    ];
  });
}

async function captureStickyForks(
  { window, output, rendered }: Pick<TodayCaptureContext, "window" | "output" | "rendered">,
  theme: string,
  unread = false,
) {
  const target = unread
    ? 'document.querySelector(\'tbody[data-fork-group="unread"] tr[data-fork="file"]\')'
    : FIRST_FORK;
  window.setContentSize(900, 800);
  await rendered("Math.abs(innerWidth - 900) <= 1");
  await window.webContents.executeJavaScript(`location.hash = "#today/forks/sync"`);
  await rendered(
    `${target}?.querySelector("[data-dim]") && !document.querySelector(".today-leaving")`,
  );
  await window.webContents.executeJavaScript(`{
    const row = ${target};
    row.scrollIntoView({ block: "center" });
    row.closest(".forks-scroll").scrollLeft = row.closest(".forks-scroll").scrollWidth;
  }`);
  const geometry = `(() => {
    const row = ${target};
    const scroller = row.closest(".forks-scroll");
    const bounds = scroller.getBoundingClientRect();
    const right = bounds.left + scroller.clientLeft + scroller.clientWidth;
    const rowSurface = getComputedStyle(row.lastElementChild).backgroundColor;
    const cells = [".forks-toggle-cell", ".forks-name-cell"].map(selector => {
      const cell = row.querySelector(selector);
      const { left, right: end, top, height } = cell.getBoundingClientRect();
      const coversEdges = [left + 1, end - 1].every(x =>
        cell.contains(document.elementFromPoint(x, top + height / 2)));
      return coversEdges && end <= right &&
        getComputedStyle(cell).backgroundColor === rowSurface;
    });
    return {
      atRight: scroller.scrollLeft > 0 &&
        Math.abs(scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft) <= 1,
      opaque: rowSurface.startsWith("rgb("),
      cells,
    };
  })()`;
  const expected = { atRight: true, opaque: true, cells: [true, true] };
  assert.deepEqual(await window.webContents.executeJavaScript(geometry), expected, "900px Forks");
  if (unread) {
    const { x, y } = await window.webContents.executeJavaScript(`(() => {
      const mark = ${target}.querySelector(".forks-name-cell .forks-unread").getBoundingClientRect();
      return { x: Math.floor(mark.left + mark.width / 2), y: Math.floor(mark.top + mark.height / 2) };
    })()`);
    await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
    });
    await rendered(`${target}.matches(":hover")`);
  } else {
    await window.webContents.executeJavaScript(`${target}.querySelector(".forks-toggle").click()`);
    await rendered(`${target}.nextElementSibling.matches(".forks-open")`);
  }
  assert.deepEqual(
    await window.webContents.executeJavaScript(geometry),
    expected,
    unread ? "900px Forks with a hovered unread row" : "900px Forks with an opened row",
  );
  const file = `forks-sticky-${unread ? "unread-hover-" : ""}${theme}.png`;
  const rows = await window.webContents.executeJavaScript(stickyRowsScript);
  assert(rows.length > 4, `${file}: the 900px Forks capture shows its rows`);
  const scale = (width: number) =>
    window.webContents.executeJavaScript("innerWidth").then((inner: number) => width / inner);
  let faults: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const image = await window.webContents.capturePage();
    const png = image.toPNG();
    const size = image.getSize();
    const bitmap = image.toBitmap();
    writeFileSync(join(output, file), png);
    assertSmokeImage(file, { ...size, bitmap, bytes: png.length });
    faults = stickyFaults({ width: size.width, bitmap }, await scale(size.width), rows);
    if (!faults.length) break;
    console.log(`${file}: capture ${attempt} not yet painted: ${faults.join("; ")}`);
    await new Promise((settle) => setTimeout(settle, 250));
    await rendered("true");
  }
  assert.deepEqual(
    faults,
    [],
    `${file}: every row in view draws its own toggle and name over the scrolled columns`,
  );
  return file;
}

export async function captureForks(
  context: Omit<TodayCaptureContext, "measure" | "sweepStatus">,
  snapshot: ViewSnapshot,
  unreadSnapshot: ViewSnapshot,
) {
  const { window, output, rendered, fixture, setupState } = context;
  const fleet = snapshot.briefing.today?.fleet;
  assert(fleet, "The 16 Nov snapshot must carry the fleet");
  const unread = new Set(fleet.stations.flatMap(({ notRead }) => notRead));
  const initial = [
    ...fleet.forks.yours,
    ...fleet.forks.rest.forks.filter((fork) => unread.has(fork)),
  ];
  const all = [...initial, ...fleet.forks.rest.forks.filter((fork) => !unread.has(fork))];
  assert(all.length > initial.length, "Forks capture needs a folded row");

  const fold = 'document.querySelector(".forks-fold")';
  const rows =
    '[...document.querySelectorAll(".forks-scroll tr[data-fork]")].map(row => row.dataset.fork)';
  const figures: string[] = [];
  for (const theme of ["light", "dark"]) {
    window.setContentSize(1440, 800);
    await window.webContents.executeJavaScript(`{
      localStorage.removeItem("spi-code.panes");
      localStorage.setItem("spi-code.appearance", ${JSON.stringify(theme)});
      location.hash = "#today/forks";
    }`);
    const loaded = once(window.webContents, "did-finish-load");
    window.webContents.reload();
    await loaded;
    await rendered('document.querySelector(".shell [data-sidebar-row=settings]")');
    await window.webContents.executeJavaScript(
      `void (Date.now = () => ${Date.parse(snapshot.sweptAt)})`,
    );
    fixture("view.snapshot", snapshot);
    fixture("setup.state", setupState);
    await rendered(`${fold} && !document.querySelector(".today-leaving") &&
      document.documentElement.dataset.theme === "${theme}" && Math.abs(innerWidth - 1440) <= 1`);
    assert.match(
      await window.webContents.executeJavaScript(`${fold}.textContent`),
      /^▸ \d+ release-only forks? · oldest \S+ on \S+$/,
      "the fold names the release-only forks",
    );
    const spans = await window.webContents.executeJavaScript(`(() => {
      const frame = document.querySelector(".today-frame");
      const sheet = document.querySelector(".forks-scroll");
      const box = frame.getBoundingClientRect();
      const style = getComputedStyle(frame);
      const left = box.left + parseFloat(style.paddingLeft);
      const right = box.right - parseFloat(style.paddingRight);
      const { left: sheetLeft, right: sheetRight } = sheet.getBoundingClientRect();
      return Math.abs(sheetLeft - left) <= 1 && Math.abs(sheetRight - right) <= 1 &&
        sheet.scrollWidth <= sheet.clientWidth &&
        sheet.querySelector("table").getBoundingClientRect().width >= sheet.clientWidth - 1 &&
        right - left > 1000;
    })()`);
    assert.equal(spans, true, "at 1440 the Forks sheet spans the centre");
    for (const [state, expected] of [
      ["folded", initial],
      ["unfolded", all],
    ] as const) {
      if (state === "unfolded") {
        await window.webContents.executeJavaScript(`${fold}.click()`);
        await rendered(`${fold}.getAttribute("aria-expanded") === "true"`);
      }
      assert.deepEqual(await window.webContents.executeJavaScript(rows), expected);
      const file = `forks-${state}-${theme}.png`;
      const path = join(output, file);
      await captureTodayFrame(context, path);
      const image = nativeImage.createFromPath(path);
      assertSmokeImage(file, {
        ...image.getSize(),
        bitmap: image.toBitmap(),
        bytes: readFileSync(path).length,
      });
      figures.push(
        `<figure><figcaption>${state}, ${theme}</figcaption><a href="${file}"><img src="${file}" alt="Today Forks ${state}, ${theme}"></a></figure>`,
      );
    }
    const sticky = await captureStickyForks(context, theme);
    figures.push(
      `<figure><figcaption>900px, scrolled right, ${theme}</figcaption><a href="${sticky}"><img src="${sticky}" alt="Today Forks scrolled right, ${theme}"></a></figure>`,
    );
    await window.webContents.executeJavaScript(
      `void (Date.now = () => ${Date.parse(unreadSnapshot.sweptAt)})`,
    );
    fixture("view.snapshot", { ...unreadSnapshot, cursor: snapshot.cursor + 1 });
    const hover = await captureStickyForks(context, theme, true);
    figures.push(
      `<figure><figcaption>900px, scrolled right, hovered unread row, ${theme}</figcaption><a href="${hover}"><img src="${hover}" alt="Today Forks with a hovered unread row, ${theme}"></a></figure>`,
    );
  }
  writeFileSync(
    join(output, "forks.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Today Forks</title>
<style>body{font:14px system-ui;margin:24px}figure{margin:24px 0}img{max-width:100%}</style>
<h1>Today Forks</h1><p>16 Nov sweep at 1440 × 800, with Today stitched as its pane scrolls, and at 900 × 800 scrolled right.
Compare the table with the Forks tab in <a href="service-design.html">draft 9</a>.</p>
${figures.join("\n")}`,
  );
}
