// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { type BrowserWindow, nativeImage } from "electron";
import type { SmokeGeometry } from "./smoke-geometry.js";
import {
  assertMorningEvidence,
  MORNING_SURFACES,
  type Morning,
  type MorningEvidence,
  morningSections,
} from "./smoke-mornings.js";
import { assertSmokeImage, type SmokeShot } from "./smoke-report.js";

export interface TodayCaptureContext {
  window: BrowserWindow;
  output: string;
  rendered(condition: string): Promise<void>;
  fixture(type: string, payload: unknown): void;
  measure(rule: "window"): Promise<SmokeGeometry>;
  /** The schema-valid sweep.status and setup.state the other Today captures use. */
  sweepStatus: unknown;
  setupState: unknown;
}

const SCROLLER = 'document.querySelector(".today-frame")?.closest(".middle-frame > *")';

const blocksScript = `(() => {
  const frame = document.querySelector(".today-frame");
  return [...frame.querySelectorAll(":scope > .today-head, :scope > .today-caveat, [data-today-slot]")]
    .map(item => {
      const { y, height } = item.getBoundingClientRect();
      const name = item.dataset.todaySlot ?? (item.classList.contains("today-caveat") ? "caveat" : "head");
      return { name, top: y, height };
    });
})()`;

export function loadMornings(paths: Readonly<Record<Morning, string>>) {
  return Object.fromEntries(
    Object.entries(paths).map(([morning, path]) => {
      const snapshot = ViewSnapshotSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      assert.equal(
        snapshot.sweptAt,
        "2026-11-06T14:02:00.133Z",
        `The ${morning} morning must share the Nov 6 sweep time the fixture clock reads`,
      );
      return [morning, { snapshot, fixture: basename(path) }];
    }),
  ) as Record<Morning, { snapshot: ViewSnapshot; fixture: string }>;
}

async function fullPage(context: TodayCaptureContext, path: string) {
  const { window, rendered } = context;
  const page: { width: number; height: number; scrollHeight: number; clientHeight: number } =
    await window.webContents.executeJavaScript(`(() => {
      const scroller = ${SCROLLER};
      scroller.scrollTop = 0;
      return { width: innerWidth, height: innerHeight, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight };
    })()`);
  const pageHeight = page.height + Math.max(0, page.scrollHeight - page.clientHeight);
  const debug = window.webContents.debugger;
  await debug.sendCommand("Emulation.setDeviceMetricsOverride", {
    width: page.width,
    height: pageHeight,
    deviceScaleFactor: 0,
    mobile: false,
  });
  try {
    await rendered(
      `innerHeight === ${pageHeight} && ${SCROLLER}.scrollHeight <= ${SCROLLER}.clientHeight + 1`,
    );
    const blocks: MorningEvidence["blocks"] =
      await window.webContents.executeJavaScript(blocksScript);
    const shot: { data: string } = await debug.sendCommand("Page.captureScreenshot", {
      format: "png",
    });
    writeFileSync(path, Buffer.from(shot.data, "base64"));
    return { ...page, pageHeight, blocks };
  } finally {
    await debug.sendCommand("Emulation.clearDeviceMetricsOverride");
    await rendered(`innerHeight === ${page.height}`);
  }
}

/**
 * Today on the calm, busy and bad mornings at each width and appearance, Detail closed and open,
 * each captured as the whole frame so blocks below the window's fold are in the image.
 */
export async function captureMornings(
  context: TodayCaptureContext,
  mornings: Record<Morning, { snapshot: ViewSnapshot; fixture: string }>,
): Promise<SmokeShot[]> {
  const { window, output, rendered, fixture } = context;
  const shots: SmokeShot[] = [];
  const widths = [...new Set(MORNING_SURFACES.flatMap(({ widths }) => widths))];
  for (const viewportWidth of widths) {
    window.setContentSize(viewportWidth, 800);
    for (const appearance of ["light", "dark"] as const) {
      for (const surface of MORNING_SURFACES) {
        if (!(surface.widths as readonly number[]).includes(viewportWidth)) continue;
        const { snapshot, fixture: fixtureName } = mornings[surface.morning];
        await window.webContents.executeJavaScript(`{
          localStorage.removeItem("spi-code.panes");
          localStorage.removeItem("spi-code.line-sheet.pinned");
          localStorage.setItem("spi-code.appearance", ${JSON.stringify(appearance)});
          location.hash = "#today";
        }`);
        const loaded = once(window.webContents, "did-finish-load");
        window.webContents.reload();
        await loaded;
        await rendered('document.querySelector(".shell [data-sidebar-row=settings]")');
        fixture("view.snapshot", snapshot);
        fixture("sweep.status", context.sweepStatus);
        fixture("setup.state", context.setupState);
        await rendered(
          `document.querySelector(".today .today-frame") && !document.querySelector(".today-leaving") && document.documentElement.dataset.theme === ${JSON.stringify(appearance)} && Math.abs(innerWidth - ${viewportWidth}) <= 1`,
        );
        let detailTitle: string | undefined;
        if (surface.detail) {
          await window.webContents.executeJavaScript(
            'document.querySelector(".today-release-released").click()',
          );
          await rendered('document.querySelector("aside[aria-label=Detail] .detail-title")');
          detailTitle = await window.webContents.executeJavaScript(
            'document.querySelector("aside[aria-label=Detail] .detail-title").textContent.trim()',
          );
        }
        const geometry = [await context.measure("window")];
        const [headline, ...qualifiers]: string[] = await window.webContents.executeJavaScript(`[
          document.querySelector(".today-headline")?.textContent.trim() ?? "",
          document.getElementById(document.querySelector("[data-sweep-line]")?.getAttribute("aria-labelledby") ?? "")?.textContent ?? "",
          document.querySelector("main .today-caveat")?.innerText?.replace(/\\s+/g, " ").trim() ?? ""
        ]`);
        const file = `${surface.id}-${viewportWidth}-${appearance}.png`;
        const path = join(output, file);
        const page = await fullPage(context, path);
        const saved = nativeImage.createFromPath(path);
        const image = assertSmokeImage(surface.id, {
          ...saved.getSize(),
          bitmap: saved.toBitmap(),
          bytes: readFileSync(path).length,
        });
        const shot: SmokeShot = {
          surface: surface.id,
          viewportWidth,
          appearance,
          file: `views/${file}`,
          geometry,
          ...image,
          qualifiers: qualifiers.map((text) => text ?? ""),
          morning: {
            morning: surface.morning,
            fixture: fixtureName,
            detail: surface.detail,
            sections: morningSections(surface.morning, surface.detail, viewportWidth),
            headline: headline ?? "",
            viewportHeight: page.height,
            scrollHeight: page.scrollHeight,
            clientHeight: page.clientHeight,
            pageHeight: page.pageHeight,
            blocks: page.blocks,
            ...(detailTitle === undefined ? {} : { detailTitle }),
          },
        };
        assertMorningEvidence(surface, shot);
        console.log(
          `Packaged Today ${surface.id}/${viewportWidth}/${appearance}: page ${page.pageHeight} of window ${page.height}, blocks ${page.blocks.map(({ name, top, height }) => `${name}@${Math.round(top)}+${Math.round(height)}`).join(" ")}${qualifiers[1] ? `; caveat "${qualifiers[1]}"` : ""}`,
        );
        shots.push(shot);
      }
    }
  }
  return shots;
}
