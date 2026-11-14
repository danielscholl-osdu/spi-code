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
import { type PaneGeometry, type Pixels, stitchPane } from "./smoke-stitch.js";

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

const SCROLLER = 'document.querySelector(".today-frame").closest(".centre-body > *")';

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

async function grab(window: BrowserWindow): Promise<Pixels> {
  const image = nativeImage.createFromBuffer((await window.webContents.capturePage()).toPNG());
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  assert.equal(bitmap.length, width * height * 4, "Invalid capture bitmap");
  return { width, height, bitmap };
}

/** Today's whole frame: the window at rest with its pane stitched to full height. */
async function fullPage(context: TodayCaptureContext, path: string) {
  const { window, rendered } = context;
  const page: PaneGeometry = await window.webContents.executeJavaScript(`(() => {
    const scroller = ${SCROLLER};
    scroller.scrollTop = 0;
    if (scroller.offsetWidth - scroller.clientWidth - 2 * scroller.clientLeft === 0)
      scroller.style.scrollbarWidth = "none";
    const { left, top } = scroller.getBoundingClientRect();
    return { width: innerWidth, height: innerHeight, left: left + scroller.clientLeft, top: top + scroller.clientTop,
      clientWidth: scroller.clientWidth, clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight };
  })()`);
  await rendered(`${SCROLLER}.scrollTop === 0`);
  const blocks: MorningEvidence["blocks"] =
    await window.webContents.executeJavaScript(blocksScript);
  const image = await stitchPane(page, await grab(window), async (target) => {
    await window.webContents.executeJavaScript(`void (${SCROLLER}.scrollTop = ${target})`);
    await rendered(`Math.abs(${SCROLLER}.scrollTop - ${target}) < 1`);
    const scrolled: number = await window.webContents.executeJavaScript(`${SCROLLER}.scrollTop`);
    return { scrolled, strip: await grab(window) };
  });
  await window.webContents.executeJavaScript(
    `{ const scroller = ${SCROLLER}; scroller.scrollTop = 0; scroller.style.scrollbarWidth = ""; }`,
  );
  writeFileSync(
    path,
    nativeImage
      .createFromBitmap(image.bitmap, { width: image.width, height: image.height })
      .toPNG(),
  );
  const pageHeight = page.height + Math.max(0, page.scrollHeight - page.clientHeight);
  return { ...page, pageHeight, blocks };
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
        const platformGeometry: SmokeGeometry = await window.webContents.executeJavaScript(`(() => {
          const bounds = element => {
            const { x, y, width, height } = element.getBoundingClientRect();
            return { x, y, width, height };
          };
          const platform = document.querySelector(".today-release-platform");
          const library = platform.querySelector(".today-release-library");
          const counts = library?.querySelector(".kit-bar-figure");
          const range = document.createRange();
          if (counts) range.selectNodeContents(counts);
          return {
            rule: "release-platform", platform: bounds(platform),
            versions: ${snapshot.releases.today?.platform.coreLibAzure.filter(({ count }) => count > 0).length ?? 0},
            library: library ? {
              bounds: bounds(library), bar: bounds(library.querySelector(".kit-bar")),
              segments: [...library.querySelectorAll(".kit-segment")].map(bounds),
              counts: bounds(counts),
              text: [...range.getClientRects()].map(({ x, y, width, height }) => ({ x, y, width, height })),
            } : null,
          };
        })()`);
        const geometry = [await context.measure("window"), platformGeometry];
        const [headline, interrupts, todayCount, ...qualifiers]: string[] =
          await window.webContents.executeJavaScript(`[
          document.querySelector(".today-headline")?.textContent.trim() ?? "",
          String(document.querySelectorAll(".today .today-needs .today-need, .today .today-stop").length),
          document.querySelector('ul[aria-label="Today"] .sidebar-pip')?.textContent.trim() ?? "",
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
            interrupts: Number(interrupts),
            todayCount: todayCount ?? "",
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
          `Packaged Today ${surface.id}/${viewportWidth}/${appearance}: page ${page.pageHeight} of window ${page.height} (pane ${Math.round(page.top)}+${page.clientHeight}), blocks ${page.blocks.map(({ name, top, height }) => `${name}@${Math.round(top)}+${Math.round(height)}`).join(" ")}${qualifiers[1] ? `; caveat "${qualifiers[1]}"` : ""}`,
        );
        shots.push(shot);
      }
    }
  }
  return shots;
}
