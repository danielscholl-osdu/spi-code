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
  window.setContentSize(1440, 800);
  for (const theme of ["light", "dark"]) {
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
  }
  writeFileSync(
    join(output, "forks.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Today Forks</title>
<style>body{font:14px system-ui;margin:24px}figure{margin:24px 0}img{max-width:100%}</style>
<h1>Today Forks</h1><p>16 Nov sweep at 1440 × 800, with Today stitched as its pane scrolls.
Compare the table with the Forks tab in <a href="service-design.html">draft 9</a>.</p>
${figures.join("\n")}`,
  );
}
