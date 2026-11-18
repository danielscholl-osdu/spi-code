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

async function captureStickyForks(
  { window, output, rendered }: Pick<TodayCaptureContext, "window" | "output" | "rendered">,
  theme: string,
) {
  window.setContentSize(900, 800);
  await rendered("Math.abs(innerWidth - 900) <= 1");
  await window.webContents.executeJavaScript(`location.hash = "#today/forks/sync"`);
  await rendered(
    `${FIRST_FORK}?.querySelector("[data-dim]") && !document.querySelector(".today-leaving")`,
  );
  await window.webContents.executeJavaScript(`{
    const row = ${FIRST_FORK};
    row.scrollIntoView({ block: "center" });
    row.closest(".forks-scroll").scrollLeft = row.closest(".forks-scroll").scrollWidth;
  }`);
  const geometry = `(() => {
    const row = ${FIRST_FORK};
    const scroller = row.closest(".forks-scroll");
    const bounds = scroller.getBoundingClientRect();
    const right = bounds.left + scroller.clientLeft + scroller.clientWidth;
    const rowSurface = getComputedStyle(row.lastElementChild).backgroundColor;
    const cells = [".forks-toggle-cell", ".forks-name-cell", ".forks-mark-cell"].map(selector => {
      const cell = row.querySelector(selector);
      const { left, right: end, top, height } = cell.getBoundingClientRect();
      const hit = document.elementFromPoint((left + end) / 2, top + height / 2);
      return cell.contains(hit) && end <= right &&
        getComputedStyle(cell).backgroundColor === rowSurface;
    });
    return {
      atRight: scroller.scrollLeft > 0 &&
        Math.abs(scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft) <= 1,
      opaque: rowSurface.startsWith("rgb("),
      cells,
    };
  })()`;
  const expected = { atRight: true, opaque: true, cells: [true, true, true] };
  assert.deepEqual(await window.webContents.executeJavaScript(geometry), expected, "900px Forks");
  await window.webContents.executeJavaScript(
    `${FIRST_FORK}.querySelector(".forks-toggle").click()`,
  );
  await rendered(`${FIRST_FORK}.nextElementSibling.matches(".forks-open")`);
  assert.deepEqual(
    await window.webContents.executeJavaScript(geometry),
    expected,
    "900px Forks with an opened row",
  );
  const file = `forks-sticky-${theme}.png`;
  const image = await window.webContents.capturePage();
  const png = image.toPNG();
  assertSmokeImage(file, { ...image.getSize(), bitmap: image.toBitmap(), bytes: png.length });
  writeFileSync(join(output, file), png);
  return file;
}

export async function captureForks(
  context: Omit<TodayCaptureContext, "measure" | "sweepStatus">,
  snapshot: ViewSnapshot,
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
