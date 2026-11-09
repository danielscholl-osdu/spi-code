// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { AssertionError } from "node:assert";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  PROTOCOL_VERSION,
  parseMessage,
  type SetupState,
  ViewSnapshotSchema,
} from "@spi-code/contracts";
import { type BrowserWindow, ipcMain, nativeImage } from "electron";
import { assertSmokeGeometry, type SmokeGeometry } from "./smoke-geometry.js";
import {
  assertSmokeShot,
  assertSmokeViews,
  geometryRules,
  type SmokeShot,
  VIEW_SURFACES,
  VIEW_WIDTHS,
} from "./smoke-report.js";
import { smokeSweepProgress } from "./smoke-sweep.js";

const sweepSchedule = {
  sweepMs: 300_000,
  gitlabMs: 1_800_000,
  securityMs: 1_800_000,
  releasesMs: 3_600_000,
};

async function rendered(window: BrowserWindow, condition: string): Promise<void> {
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = performance.now() + 5000;
    const check = () => {
      if (${condition}) return requestAnimationFrame(() => requestAnimationFrame(resolve));
      if (performance.now() > deadline) return reject(new Error("View smoke DOM timeout: " + ${JSON.stringify(condition)} +
        "; " + JSON.stringify({ checked: document.querySelector(".readiness-checked")?.textContent,
          deviceCode: !!document.querySelector(".readiness-code"), now: Date.now(),
          zone: Intl.DateTimeFormat().resolvedOptions().timeZone })));
      setTimeout(check, 20);
    };
    check();
  })`);
}

function fixture(window: BrowserWindow, type: string, payload: unknown, id = "smoke-views"): void {
  const parsed = parseMessage({
    version: PROTOCOL_VERSION,
    id,
    kind: type === "inspect.result" ? "response" : "event",
    type,
    payload,
  });
  assert(parsed.ok, `Invalid smoke fixture: ${type}`);
  window.webContents.send("smoke:fixture", parsed.message);
}

async function settingsSection(
  window: BrowserWindow,
  section: "readiness" | "appearance",
): Promise<void> {
  await window.webContents.executeJavaScript(`{
    const picker = document.querySelector(".settings-picker select");
    if (picker) {
      picker.value = ${JSON.stringify(section)};
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      [...document.querySelectorAll(".settings-nav button")].find(item =>
        item.textContent === ${JSON.stringify(section === "appearance" ? "Appearance" : "Readiness")}
      ).click();
    }
  }`);
  await rendered(window, `document.querySelector("[data-settings-section=${section}]")`);
}

async function openSettings(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(`{
    const mac = /Mac|iPhone|iPad/.test(navigator.userAgent);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: mac, ctrlKey: !mac, bubbles: true }));
  }`);
  await rendered(window, 'document.querySelector("[role=dialog]")');
}

async function closeSettings(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(
    "document.querySelector(\"[aria-label='Close settings']\").click()",
  );
  await rendered(window, '!document.querySelector("[role=dialog]")');
}

async function measure(window: BrowserWindow, rule: SmokeGeometry["rule"]): Promise<SmokeGeometry> {
  const value: unknown = await window.webContents.executeJavaScript(`(() => {
    const element = selector => {
      const item = document.querySelector(selector);
      if (!item) throw new Error("Missing geometry element: " + selector);
      return item;
    };
    const rect = item => {
      const { x, y, width, height } = item.getBoundingClientRect();
      return { x, y, width, height };
    };
    const viewport = { x: 0, y: 0, width: innerWidth, height: innerHeight };
    const page = document.scrollingElement;
    if (!page) throw new Error("Missing page scroll geometry");
    const scroll = { width: page.scrollWidth, height: page.scrollHeight };
    switch (${JSON.stringify(rule)}) {
      case "window":
        return { rule: "window", viewport, scroll,
          panes: [...document.querySelectorAll(".app-sidebar:not([inert]), .middle-frame, .line-sheet, .right-panel-frame")].map(rect) };
      case "related":
        return { rule: "related", panel: rect(element(".right-panel-frame")),
          label: rect(element(".inspector-related dt")), labelText: element(".inspector-related dt").textContent,
          values: [...document.querySelectorAll(".inspector-related dd")].map(rect) };
      case "panes":
        return { rule: "panes", viewport, scroll, panes: [".app-sidebar", ".middle-frame", ".line-sheet", ".right-panel"].map(selector => {
          const item = element(selector);
          const style = getComputedStyle(item);
          return { rect: rect(item), borderLeft: parseFloat(style.borderLeftWidth), borderRight: parseFloat(style.borderRightWidth) };
        }) };
      case "headers": {
        const panes = [".middle-frame", ".line-sheet", ".right-panel"]
          .map(selector => document.querySelector(selector)).filter(Boolean);
        return { rule: "headers", paneTop: rect(element(".middle-frame")).y,
          panes: panes.map(item => {
            const bounds = rect(item);
            const style = getComputedStyle(item);
            const left = parseFloat(style.borderLeftWidth);
            return { ...bounds, x: bounds.x + left, width: bounds.width - left - parseFloat(style.borderRightWidth) };
          }),
          headers: panes.map(item => rect(item.querySelector(".pane-header"))) };
      }
      case "settings":
        return { rule: "settings", viewport, dialog: rect(element("[role=dialog].settings")) };
      case "drag": {
        const title = element(".title-bar");
        const bounds = rect(title);
        const style = getComputedStyle(title);
        const left = parseFloat(style.paddingLeft);
        const right = parseFloat(style.paddingRight);
        return { rule: "drag", services: document.querySelectorAll("[data-strip] [data-service]").length,
          appRegion: style.getPropertyValue("-webkit-app-region"),
          region: { x: bounds.x + left, y: bounds.y, width: bounds.width - left - right, height: 44 },
          targets: [...title.querySelectorAll("button, select, input, textarea, a, label, summary")]
            .filter(item => item.getBoundingClientRect().width > 0 && getComputedStyle(item).visibility !== "hidden").map(rect) };
      }
    }
  })()`);
  assertSmokeGeometry(value);
  return value;
}

async function brokenRelatedProbe(window: BrowserWindow): Promise<string> {
  const original: string = await window.webContents.executeJavaScript(`(() => {
    const value = document.querySelector(".inspector-related dd");
    const original = value.style.width;
    value.style.width = "159px";
    return original;
  })()`);
  try {
    await measure(window, "related");
    assert.fail("Broken Related geometry passed");
  } catch (error) {
    if (!(error instanceof AssertionError) || error.message !== "Related value squeezed to 159 px")
      throw error;
    console.log(`Packaged broken-rule proof rejected: ${error.message}`);
    return error.message;
  } finally {
    await window.webContents.executeJavaScript(
      `document.querySelector(".inspector-related dd").style.width = ${JSON.stringify(original)}`,
    );
    await rendered(
      window,
      'document.querySelector(".inspector-related dd").getBoundingClientRect().width >= 160',
    );
  }
}

export async function captureSmokeViews(
  window: BrowserWindow,
  reportPath: string,
  fixturePath: string,
  designPath: string,
): Promise<SmokeShot[]> {
  const snapshot = ViewSnapshotSchema.parse(JSON.parse(readFileSync(fixturePath, "utf8")));
  const progress = smokeSweepProgress();
  const [originalWidth, originalHeight] = window.getContentSize();
  assert(originalWidth && originalHeight, "Missing original smoke viewport");
  assert.equal(snapshot.sweptAt, "2026-11-06T14:02:00.133Z", "Views require the Nov 6 projection");
  const output = join(dirname(reportPath), "views");
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "design.html"), readFileSync(designPath));
  const checkedAt = "2026-11-06T15:04:00.000Z";
  const ready: SetupState = {
    checkedAt,
    watchReady: true,
    disabledReason: null,
    tools: [
      { tool: "copilot", state: "ready", action: null, reason: "octocat · Business seat" },
      { tool: "git", state: "ready", action: null, version: "2.56.0" },
      { tool: "gh", state: "ready", action: null, version: "2.83.0" },
      { tool: "glab", state: "ready", action: null, version: "1.128.0" },
    ],
  };
  let ghRequest = "";
  const request = (event: Electron.IpcMainEvent, input: unknown) => {
    if (event.sender !== window.webContents) return;
    const parsed = parseMessage(input);
    assert(parsed.ok, "Invalid renderer smoke request");
    const message = parsed.message;
    if (message.type === "setup.signin") {
      if (message.payload.tool === "gh") ghRequest = message.id;
      fixture(
        window,
        "setup.signin.progress",
        message.payload.tool === "glab"
          ? {
              tool: "glab",
              requestId: message.id,
              state: "failed",
              reason: "Fixture token refused",
            }
          : {
              tool: "gh",
              requestId: message.id,
              state: "device-code",
              deviceCode: "WDJB-MJHT",
              url: "https://github.com/login/device",
            },
      );
    } else if (message.type === "inspect.request") {
      fixture(
        window,
        "inspect.result",
        {
          id: message.payload.id,
          class: "TOOLCHAIN",
          cause: "The Related width geometry fixture.",
          effect: "",
          next: "",
          why: "",
          evidence: [],
          approval: null,
          actions: [],
          related: [
            {
              state:
                "A deliberately long Related label that wraps over multiple lines at a 280 px right panel",
              text: "The Related value retains its full reading width.",
            },
            { state: "", text: "A second value without a label also keeps its width." },
          ],
        },
        message.id,
      );
    }
  };
  const shots: SmokeShot[] = [];
  let clockScript: string | undefined;
  window.webContents.debugger.attach("1.3");
  ipcMain.on("smoke:request", request);
  try {
    await window.webContents.debugger.sendCommand("Page.enable");
    await window.webContents.debugger.sendCommand("Emulation.setTimezoneOverride", {
      timezoneId: "America/Chicago",
    });
    const clock: { identifier: string } = await window.webContents.debugger.sendCommand(
      "Page.addScriptToEvaluateOnNewDocument",
      {
        source: `Date.now = () => ${Date.parse(checkedAt)};`,
      },
    );
    clockScript = clock.identifier;
    const first = VIEW_SURFACES.find(({ id }) => id === "settings-first-launch");
    assert(first);
    const surfaces: (typeof VIEW_SURFACES)[number][] = [
      first,
      ...VIEW_SURFACES.filter(({ id }) => id !== first.id),
    ];
    for (const viewportWidth of VIEW_WIDTHS) {
      window.setContentSize(viewportWidth, 800);
      for (const appearance of ["light", "dark"] as const) {
        ghRequest = "";
        await window.webContents.executeJavaScript(`{
          localStorage.removeItem("spi-code.panes");
          localStorage.removeItem("spi-code.line-sheet.pinned");
          localStorage.setItem("spi-code.appearance", ${JSON.stringify(appearance)});
          location.hash = "#today";
        }`);
        const loaded = once(window.webContents, "did-finish-load");
        window.webContents.reload();
        await loaded;
        await rendered(window, 'document.querySelector(".shell [data-sidebar-row=settings]")');
        fixture(window, "view.snapshot", snapshot);
        fixture(window, "sweep.status", {
          remaining: 4865,
          floor: 100,
          resetAt: "2026-11-06T15:36:00.000Z",
          deferredAreas: [],
          nextSweepAt: null,
          schedule: sweepSchedule,
          lastSweep: null,
        });
        fixture(window, "setup.state", {
          ...ready,
          watchReady: false,
          disabledReason: "Watch needs gh.",
          tools: ready.tools.map((tool) =>
            tool.tool === "gh"
              ? { tool: "gh", state: "signed-out", action: "signin" }
              : tool.tool === "glab"
                ? { tool: "glab", state: "installing", action: null, version: "1.128.0" }
                : tool,
          ),
        });
        await rendered(
          window,
          'document.querySelector("[role=dialog] .settings-readiness-banner")',
        );
        await settingsSection(window, "appearance");
        await window.webContents.executeJavaScript(
          `document.querySelector('input[name="settings-theme"][value="${appearance}"]').click()`,
        );
        await rendered(
          window,
          `document.documentElement.dataset.theme === "${appearance}" && localStorage.getItem("spi-code.appearance") === "${appearance}"`,
        );
        await settingsSection(window, "readiness");
        await window.webContents.executeJavaScript(
          'document.querySelector(".readiness-row[aria-label=gh] .readiness-action").click()',
        );
        await rendered(
          window,
          'document.querySelector(".readiness-code") && document.querySelector(".readiness-checked")?.textContent.trim() === "Checked 09:04"',
        );
        for (const surface of surfaces) {
          if (surface.id === "first-sweep-running") {
            await window.webContents.executeJavaScript(`{
              localStorage.removeItem("spi-code.panes");
              localStorage.removeItem("spi-code.line-sheet.pinned");
              location.hash = "#today";
            }`);
            const loaded = once(window.webContents, "did-finish-load");
            window.webContents.reload();
            await loaded;
            await rendered(window, 'document.querySelector(".today-first")');
            fixture(window, "setup.state", {
              ...ready,
              tools: ready.tools.map((tool) =>
                tool.tool === "glab"
                  ? {
                      tool: "glab",
                      state: "signed-out",
                      action: "signin",
                      reason: "glab is not signed in to community.opengroup.org.",
                    }
                  : tool,
              ),
            });
            fixture(window, "sweep.status", {
              remaining: 123,
              floor: 100,
              resetAt: "2026-11-06T15:10:00.000Z",
              deferredAreas: [{ area: "details", reason: "budget" }],
              nextSweepAt: null,
              schedule: sweepSchedule,
              lastSweep: null,
            });
          }
          if (surface.id !== first.id) {
            await window.webContents.executeJavaScript(
              `location.hash = ${JSON.stringify(`#${surface.route}`)}`,
            );
            await rendered(
              window,
              `document.querySelector("[data-place]")?.textContent === ${JSON.stringify(surface.place)}`,
            );
          }
          if (surface.id.startsWith("first-sweep-")) {
            const state =
              surface.id === "first-sweep-throttled"
                ? progress.throttled
                : surface.id === "first-sweep-stopped"
                  ? progress.stopped
                  : surface.id === "first-sweep-stopped-saving"
                    ? progress.stoppedSaving
                    : progress.running;
            if (surface.id === "first-sweep-evidence") {
              fixture(window, "sweep.progress", progress.committed);
              await rendered(
                window,
                'document.querySelector(".today-first") && document.querySelectorAll(".sweep-row").length === 12',
              );
              fixture(window, "view.snapshot", snapshot);
              await rendered(
                window,
                'document.querySelector(".today .place-reading") && !document.querySelector(".today-leaving")',
              );
              await window.webContents.executeJavaScript(
                'document.querySelector("[data-sweep-line]").click()',
              );
              await rendered(window, `document.querySelector(${JSON.stringify(surface.selector)})`);
              const retained = await window.webContents.executeJavaScript(`[
                ...document.querySelectorAll("[data-sweep-list=completed] .sweep-row")
              ].map(row => ({ source: row.dataset.source,
                outcome: row.querySelector(".sweep-outcome").textContent.trim() }))`);
              assert.deepEqual(
                retained.map((row: { source: string }) => row.source),
                progress.committed.sources.map(({ source }) => source),
                "Hand-over must retain all twelve sources in sweep order",
              );
              assert(
                retained.every((row: { outcome: string }) => !/waiting|reading/.test(row.outcome)),
              );
            } else if (surface.id === "first-sweep-refresh") {
              const brief = await window.webContents.executeJavaScript(
                'document.querySelector(".today").outerHTML',
              );
              fixture(window, "sweep.progress", progress.refresh);
              await rendered(
                window,
                'document.querySelector("[data-sweep-display]")?.textContent.includes("sweeping 4 of 12")',
              );
              assert.equal(
                await window.webContents.executeJavaScript(
                  'document.querySelector(".today").outerHTML',
                ),
                brief,
                "A later sweep must not reflow the older brief",
              );
            } else {
              fixture(window, "sweep.progress", state);
              await rendered(
                window,
                surface.id === "first-sweep-place"
                  ? 'document.querySelector(".place-before-sweep")?.textContent.includes("9th of 12")'
                  : 'document.querySelectorAll(".today-first .sweep-row").length === 12',
              );
            }
          }
          if (surface.id === "line" || surface.id === "panes") {
            await window.webContents.executeJavaScript(
              'document.querySelector(".strip-pips").click()',
            );
            await rendered(window, 'document.querySelector(".line-grid")');
          }
          if (surface.id === "detail") {
            await window.webContents.executeJavaScript(
              "document.querySelector(\".place-item-content[data-selection-id='campaign:toolchain:os-core-common%208.5.0']\").click()",
            );
          }
          if (surface.id === "detail-related" || surface.id === "panes") {
            if (surface.id === "panes") {
              await window.webContents.executeJavaScript(
                '[...document.querySelectorAll(".line-toolbar button")].find(button => button.textContent === "Pin").click()',
              );
              await rendered(
                window,
                'document.querySelector(".line-sheet:not([data-presentation=overlay])")',
              );
              await window.webContents.executeJavaScript(
                "document.querySelector(\"[aria-label='Toggle right panel']\").click()",
              );
            } else {
              await window.webContents.executeJavaScript(`{
                localStorage.setItem("spi-code.panes", JSON.stringify({
                  widths: { sidebar: 232, rightPanel: 280, lineSheet: 360 },
                  open: { sidebar: true, rightPanel: false }
                }));
              }`);
              const loaded = once(window.webContents, "did-finish-load");
              window.webContents.reload();
              await loaded;
              await rendered(
                window,
                'document.querySelector(".shell [data-sidebar-row=settings]")',
              );
              fixture(window, "view.snapshot", snapshot);
              fixture(window, "sweep.status", {
                remaining: 4865,
                floor: 100,
                resetAt: "2026-11-06T15:36:00.000Z",
                deferredAreas: [],
                nextSweepAt: null,
                schedule: sweepSchedule,
                lastSweep: null,
              });
              fixture(window, "setup.state", ready);
              await rendered(window, 'document.querySelector(".upstream .place-reading")');
              await window.webContents.executeJavaScript(
                'document.querySelector(".upstream-theme-head").click()',
              );
            }
          }
          if (surface.id.startsWith("settings") && surface.id !== first.id) {
            await openSettings(window);
            await settingsSection(
              window,
              surface.id === "settings-appearance" ? "appearance" : "readiness",
            );
            if (surface.id === "settings-failed") {
              fixture(window, "setup.state", {
                ...ready,
                tools: ready.tools.map((tool) =>
                  tool.tool === "glab"
                    ? {
                        tool: "glab",
                        state: "signed-out",
                        action: "signin",
                        reason:
                          "Paste a personal access token for community.opengroup.org with the api scope.",
                      }
                    : tool,
                ),
              });
              await rendered(window, 'document.querySelector(".readiness-token input")');
              await window.webContents.executeJavaScript(`{
                const input = document.querySelector(".readiness-token input");
                input.value = "fixture-token";
                input.dispatchEvent(new Event("input", { bubbles: true }));
              }`);
              await rendered(window, '!document.querySelector(".readiness-token button").disabled');
              await window.webContents.executeJavaScript(
                'document.querySelector(".readiness-token").requestSubmit()',
              );
            }
          }
          if (surface.id === "strip-20") {
            const stations = [...snapshot.stations];
            const seed = stations[0];
            assert(seed);
            while (stations.length < 20)
              stations.push({ ...seed, service: `smoke-service-${stations.length + 1}` });
            fixture(
              window,
              "view.snapshot",
              ViewSnapshotSchema.parse({ ...snapshot, cursor: snapshot.cursor + 1, stations }),
            );
          }
          await rendered(window, `document.querySelector(${JSON.stringify(surface.selector)})`);
          if (surface.id === "first-sweep-evidence") {
            await window.webContents.executeJavaScript(
              'document.querySelector(".evidence-failures").scrollIntoView({ block: "end" })',
            );
            await rendered(
              window,
              `(() => {
                const failed = document.querySelector(".evidence-failures").getBoundingClientRect();
                const panel = document.querySelector(".panel-body").getBoundingClientRect();
                const row = document.querySelector(".evidence-failure");
                return failed.top >= panel.top && failed.bottom <= panel.bottom &&
                  row.querySelector(".sweep-name").textContent === "GitHub issues and PRs" &&
                  row.querySelector(".sweep-outcome").textContent === "read failed · unit, crs-catalog, crs-conversion";
              })()`,
            );
          }
          const geometry = [];
          for (const rule of geometryRules(surface.id, viewportWidth))
            geometry.push(await measure(window, rule));
          const bounds = geometry.find((check) => check.rule === "window");
          assert(bounds?.rule === "window");
          console.log(
            `Packaged window ${surface.id}/${viewportWidth}/${appearance}: viewport ${bounds.viewport.width}x${bounds.viewport.height}, page ${bounds.scroll.width}x${bounds.scroll.height}, edges 0..${Math.max(...bounds.panes.map((pane) => pane.x + pane.width))}, bottom ${Math.max(...bounds.panes.map((pane) => pane.y + pane.height))}`,
          );
          const rejectedGeometry =
            surface.id === "detail-related" && viewportWidth === 1440 && appearance === "light"
              ? await brokenRelatedProbe(window)
              : undefined;
          const qualifiers: string[] = await window.webContents.executeJavaScript(`[
            document.getElementById(document.querySelector("[data-sweep-line]")?.getAttribute("aria-labelledby") ?? "")?.textContent ?? "",
            document.querySelector(${JSON.stringify(
              surface.id === "first-sweep-evidence"
                ? "[data-evidence=sweep]"
                : surface.id === "first-sweep-place"
                  ? ".place-before-sweep"
                  : surface.id.startsWith("first-sweep-") && surface.id !== "first-sweep-refresh"
                    ? ".today-first"
                    : "main .place-qualifier",
            )})?.innerText?.replace(/\\s+/g, " ").trim() ?? ""
          ]`);
          const file = `${surface.id}-${viewportWidth}-${appearance}.png`;
          const path = join(output, file);
          writeFileSync(path, (await window.webContents.capturePage()).toPNG());
          const saved = nativeImage.createFromPath(path);
          const shot = assertSmokeShot(
            surface.id,
            { ...saved.getSize(), bitmap: saved.toBitmap(), bytes: readFileSync(path).length },
            qualifiers,
          );
          shots.push({
            surface: surface.id,
            viewportWidth,
            appearance,
            file: `views/${file}`,
            geometry,
            ...(rejectedGeometry ? { rejectedGeometry } : {}),
            ...shot,
          });
          if (surface.id.startsWith("settings")) {
            if (surface.id === first.id)
              fixture(window, "setup.signin.progress", {
                tool: "gh",
                requestId: ghRequest,
                state: "completed",
              });
            fixture(window, "setup.state", ready);
            await closeSettings(window);
          }
          if (surface.id === "line" || surface.id === "panes")
            await window.webContents.executeJavaScript(
              "document.querySelector(\"[aria-label='Close Line']\").click()",
            );
          if (["detail", "detail-related", "panes", "first-sweep-evidence"].includes(surface.id))
            await window.webContents.executeJavaScript(
              "document.querySelector(\"[aria-label='Close detail']\").click()",
            );
        }
      }
    }
    assertSmokeViews(shots);
  } finally {
    ipcMain.removeListener("smoke:request", request);
    if (clockScript)
      await window.webContents.debugger.sendCommand("Page.removeScriptToEvaluateOnNewDocument", {
        identifier: clockScript,
      });
    await window.webContents.debugger.sendCommand("Emulation.setTimezoneOverride", {
      timezoneId: "",
    });
    await window.webContents.executeJavaScript(`{
      localStorage.removeItem("spi-code.panes");
      localStorage.removeItem("spi-code.line-sheet.pinned");
      location.hash = "#today";
    }`);
    window.setContentSize(originalWidth, originalHeight);
    window.webContents.debugger.detach();
    const loaded = once(window.webContents, "did-finish-load");
    window.webContents.reload();
    await loaded;
  }
  writeFileSync(
    join(output, "index.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Packaged Watch views</title>
<style>body{font-family:system-ui;margin:24px}table{width:100%;border-collapse:collapse}td,th{border:1px solid #888;padding:8px;vertical-align:top}img{width:100%}td{width:50%}</style>
<h1>Packaged Watch views</h1><p>Nov 6 projection: ${snapshot.sweptAt}. Content bounds: 1440, 900 and 740 x 800.
Appearance pinned in the app. Fixture clock: Nov 6, 09:04 America/Chicago.
Setup sign-ins are intercepted fixtures, never live authentication. Related and 20-service probes vary the projection.
First-sweep surfaces inject schema-valid sweep.progress messages through the same smoke-only preload channel as
view.snapshot and setup.state. This screenshot phase precedes host startup, so it cannot feed the real host progress path;
the persisted-snapshot and supervision host proof runs separately, after these fixtures are removed.
Only view.snapshot hands over the first-sweep list; the refresh preserves the older brief.
These captures support the maintainer's checkpoint; the smoke gives no visual verdict.</p>
<p><a href="design.html">design/spi-code-window-layout.html</a> is the layout authority.
Blank gate: 640 x 400 pixels, 1024 PNG bytes, no quantized RGB bucket at 99.5%.</p>
${VIEW_SURFACES.map(
  (surface) => `<section><h2>${surface.name}</h2><p>Design: ${surface.designSection}</p>
${VIEW_WIDTHS.map(
  (width) =>
    `<h3>${width} px</h3><table><tr><th>Light</th><th>Dark</th></tr><tr>${["light", "dark"]
      .map((appearance) => {
        const file = `${surface.id}-${width}-${appearance}.png`;
        const shot = shots.find(
          (shot) =>
            shot.surface === surface.id &&
            shot.viewportWidth === width &&
            shot.appearance === appearance,
        );
        return `<td><a href="${file}"><img alt="${surface.name}, ${width} px, ${appearance}" src="${file}"></a><p>Geometry: ${shot?.geometry.map((check) => check.rule).join(", ") || "not probed on this surface"}</p></td>`;
      })
      .join("")}</tr></table>`,
).join("")}</section>`,
).join("\n")}
</html>\n`,
  );
  return shots;
}
