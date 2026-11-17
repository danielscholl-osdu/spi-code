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
  DRAWN_MEMBERS,
  lineMembersText,
  MORNING_SURFACES,
  type Morning,
  type MorningEvidence,
  membersText,
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
  return [...frame.querySelectorAll(":scope > .today-caveat, .today-table-calm, .today-section[data-section]")]
    .map(item => {
      const { y, height } = item.getBoundingClientRect();
      const name = item.dataset.section ?? (item.classList.contains("today-caveat") ? "caveat" : "calm");
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
 * Today on the calm, busy and bad mornings at each width and appearance, and with its first row
 * opened in place, each captured as the whole frame so blocks below the window's fold are in the image.
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
        let opened: string | undefined;
        if (surface.open) {
          await window.webContents.executeJavaScript(
            'document.querySelector(".today [data-section] tr.today-row:not(.today-row--place) .today-row-fork button").click()',
          );
          const place =
            ".today tr.today-row[data-open] + tr.today-row-body[data-open] .opened-body-place";
          await rendered(`document.querySelector(${JSON.stringify(place)})`);
          opened = await window.webContents.executeJavaScript(
            `document.querySelector(${JSON.stringify(place)}).textContent.trim()`,
          );
        }
        const geometry = [await context.measure("window")];
        const [headline, members, todayCount, ...qualifiers]: [
          string,
          Record<string, string[]>,
          string,
          ...string[],
        ] = await window.webContents.executeJavaScript(`[
          document.querySelector(".today .today-table-calm")?.textContent.trim() ?? "",
          ${DRAWN_MEMBERS},
          document.querySelector('[data-sidebar-row=today] .sidebar-pip')?.textContent.trim() ?? "",
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
            open: surface.open,
            sections: morningSections(surface.morning, surface.open, viewportWidth),
            headline: headline ?? "",
            members: membersText(members),
            lineMembers: lineMembersText(snapshot.briefing.lines),
            todayCount: todayCount ?? "",
            viewportHeight: page.height,
            scrollHeight: page.scrollHeight,
            clientHeight: page.clientHeight,
            pageHeight: page.pageHeight,
            blocks: page.blocks,
            ...(opened === undefined ? {} : { opened }),
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
