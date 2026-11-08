// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PROTOCOL_VERSION, ViewSnapshotSchema } from "@spi-code/contracts";
import { type BrowserWindow, nativeImage } from "electron";
import { assertSmokeShot, type SmokeShot, VIEW_SURFACES } from "./smoke-report.js";

async function rendered(window: BrowserWindow, condition: string): Promise<void> {
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = performance.now() + 5000;
    const check = () => {
      if (${condition}) return requestAnimationFrame(() => requestAnimationFrame(resolve));
      if (performance.now() > deadline) return reject(new Error("View smoke DOM timeout: " + ${JSON.stringify(condition)}));
      setTimeout(check, 20);
    };
    check();
  })`);
}

export async function captureSmokeViews(
  window: BrowserWindow,
  reportPath: string,
  fixturePath: string,
  designPath: string,
): Promise<SmokeShot[]> {
  const snapshot = ViewSnapshotSchema.parse(JSON.parse(readFileSync(fixturePath, "utf8")));
  assert.equal(snapshot.sweptAt, "2026-11-06T14:02:00.133Z", "Views require the Nov 6 projection");
  const output = join(dirname(reportPath), "views");
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "design.html"), readFileSync(designPath));
  window.setContentSize(1280, 800);
  const shots: SmokeShot[] = [];
  for (const appearance of ["light", "dark"] as const) {
    await rendered(window, 'document.querySelector("header [data-place]")');
    window.webContents.send("smoke:fixture", {
      version: PROTOCOL_VERSION,
      id: "smoke-views",
      kind: "event",
      type: "view.snapshot",
      payload: snapshot,
    });
    window.webContents.send("smoke:fixture", {
      version: PROTOCOL_VERSION,
      id: "smoke-setup",
      kind: "event",
      type: "setup.state",
      payload: {
        watchReady: true,
        disabledReason: null,
        tools: ["copilot", "git", "gh", "glab"].map((tool) => ({
          tool,
          state: "ready",
          action: null,
        })),
      },
    });
    await rendered(window, 'document.querySelector("[data-strip] [data-service=entitlements]")');
    await window.webContents.executeJavaScript(`{
      const mac = /Mac|iPhone|iPad/.test(navigator.userAgent);
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: ",", metaKey: mac, ctrlKey: !mac, bubbles: true }),
      );
    }`);
    await rendered(window, 'document.querySelector("[role=dialog] .settings-nav")');
    await window.webContents.executeJavaScript(
      `[...document.querySelectorAll("[role=dialog] .settings-nav button")].find((item) => item.textContent === "Appearance").click()`,
    );
    await rendered(window, 'document.querySelector("[data-settings-section=appearance]")');
    await window.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(`input[name="settings-theme"][value="${appearance}"]`)}).click()`,
    );
    await rendered(
      window,
      `document.documentElement.dataset.theme === ${JSON.stringify(appearance)} &&
       localStorage.getItem("spi-code.appearance") === ${JSON.stringify(appearance)}`,
    );
    await window.webContents.executeJavaScript(
      "document.querySelector(\"[role=dialog] [aria-label='Close settings']\").click()",
    );
    await rendered(window, '!document.querySelector("[role=dialog]")');
    for (const surface of VIEW_SURFACES) {
      await window.webContents.executeJavaScript(
        `location.hash = ${JSON.stringify(`#${surface.route}`)}`,
      );
      await rendered(
        window,
        `document.querySelector("[data-place]")?.textContent === ${JSON.stringify(surface.place)}`,
      );
      if (surface.id === "line") {
        await window.webContents.executeJavaScript('document.querySelector(".strip-line").click()');
      }
      if (surface.id === "detail") {
        await window.webContents.executeJavaScript(
          "document.querySelector(\".place-item-content[data-selection-id='campaign:toolchain:os-core-common%208.5.0']\").click()",
        );
      }
      if (surface.id === "settings") {
        await window.webContents.executeJavaScript(
          'document.querySelector("[data-sidebar-row=settings]").click()',
        );
      }
      await rendered(window, `document.querySelector(${JSON.stringify(surface.selector)})`);
      const qualifiers: string[] = await window.webContents.executeJavaScript(`[
        document.querySelector("[data-sweep-line]")?.innerText?.trim() ?? "",
        document.querySelector("main .place-qualifier")?.innerText?.trim() ?? ""
      ]`);
      const image = await window.webContents.capturePage();
      const file = `${surface.id}-${appearance}.png`;
      const path = join(output, file);
      writeFileSync(path, image.toPNG());
      const saved = nativeImage.createFromPath(path);
      const shot = assertSmokeShot(
        surface.id,
        {
          ...saved.getSize(),
          bitmap: saved.toBitmap(),
          bytes: readFileSync(path).length,
        },
        qualifiers,
      );
      shots.push({ surface: surface.id, appearance, file: `views/${file}`, ...shot });
      if (surface.id === "line")
        await window.webContents.executeJavaScript(
          "document.querySelector(\"[aria-label='Close Line']\").click()",
        );
      if (surface.id === "detail")
        await window.webContents.executeJavaScript(
          "document.querySelector(\"[aria-label='Close detail']\").click()",
        );
      if (surface.id === "settings") {
        await window.webContents.executeJavaScript(
          "document.querySelector(\"[role=dialog] [aria-label='Close settings']\").click()",
        );
        await rendered(window, '!document.querySelector("[role=dialog]")');
      }
    }
    const loaded = once(window.webContents, "did-finish-load");
    window.webContents.reload();
    await loaded;
  }
  writeFileSync(
    join(output, "index.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Packaged Watch views</title>
<style>body{font-family:system-ui;margin:24px}table{width:100%;border-collapse:collapse}td,th{border:1px solid #888;padding:8px;vertical-align:top}img{width:100%}td{width:50%}</style>
<h1>Packaged Watch views</h1><p>Fixture: snapshot-1106.json, ${snapshot.sweptAt}.
1280 x 800 content bounds. Appearance pinned in the app, not the OS.
Setup tools are fixture-ready, not a live authentication check.
Each image includes the title bar and strip. Reviewer: record match or mismatch for each surface in the bead; no visual verdict is inferred by the smoke.</p>
<p><a href="design.html">design/spi-code-window-design.html</a> is the layout authority.
Blank gate: at least 640 x 400 pixels and 1024 PNG bytes; no quantized RGB bucket may occupy 99.5% of the image.</p>
${VIEW_SURFACES.map(
  (surface) => `<section><h2>${surface.name}</h2>
<p>Design section: ${surface.designSection}. Review verdict: pending.</p>
<table><tr><th>Light</th><th>Dark</th></tr><tr>${["light", "dark"]
    .map(
      (appearance) =>
        `<td><a href="${surface.id}-${appearance}.png"><img alt="${surface.name}, ${appearance}" src="${surface.id}-${appearance}.png"></a></td>`,
    )
    .join("")}</tr></table></section>`,
).join("\n")}
</html>\n`,
  );
  return shots;
}
