// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { AssertionError } from "node:assert";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  PROTOCOL_VERSION,
  parseMessage,
  type SetupState,
  type ViewSnapshot,
  ViewSnapshotSchema,
} from "@spi-code/contracts";
import { type BrowserWindow, ipcMain, nativeImage } from "electron";
import { assertSmokeGeometry, type SmokeGeometry } from "./smoke-geometry.js";
import { MORNING_SURFACES, type Morning } from "./smoke-mornings.js";
import {
  assertSmokeShot,
  assertSmokeViews,
  geometryRules,
  type SmokeShot,
  VIEW_SURFACES,
  VIEW_WIDTHS,
} from "./smoke-report.js";
import { smokeScheduledSweep, smokeSweepProgress } from "./smoke-sweep.js";
import { captureMornings, loadMornings } from "./smoke-today.js";

const sweepSchedule = {
  sweepMs: 300_000,
  gitlabMs: 1_800_000,
  securityMs: 1_800_000,
  releasesMs: 3_600_000,
};

/** Written by scripts/watch-snapshot.mjs beside the Nov 6 fixture: that sweep after its acknowledgement. */
export const ACKNOWLEDGED_FIXTURE = "snapshot-1106-acknowledged.json";

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

async function captureCapsuleStates(
  window: BrowserWindow,
  snapshot: ViewSnapshot,
  output: string,
  appearance: string,
  now: number,
  cursor: number,
): Promise<void> {
  const scenes = [
    "fine",
    "waiting",
    "stopped",
    "maintenance",
    "refreshing",
    "unread",
    "sync",
  ] as const;
  const images: string[] = [];
  await window.webContents.executeJavaScript(`void (Date.now = () => ${now})`);
  for (const scene of scenes) {
    const body = structuredClone(snapshot);
    body.cursor = cursor++;
    delete body.briefing.nextSyncAt;
    const environment = body.briefing.facts.find(({ label }) => label === "Environment");
    assert(environment);
    environment.tone = "ok";
    environment.sub = "deployable";
    const holds = body.briefing.environment.lanes.find(({ id }) => id === "holds");
    if (holds) holds.events = [];
    for (const row of body.stations)
      for (const station of row.stations) {
        station.state = "idle";
        station.substate = "ready";
      }
    const visual = body.briefing.places?.find(({ place }) => place === "engineering")?.visual;
    assert(visual?.kind === "rollout");
    for (const slot of visual.slots) slot.state = "done";
    if (scene === "waiting" || scene === "stopped") {
      const pending = visual.slots[0];
      assert(pending);
      pending.state = "waiting";
      if (scene === "stopped") {
        const failed = visual.slots[1];
        assert(failed);
        failed.state = "broken";
      }
      for (const row of body.stations.slice(0, scene === "waiting" ? 2 : 4)) {
        const station = row.stations.find(({ id }) => id === "cascade");
        assert(station);
        station.state = scene === "waiting" ? "waiting" : "stopped";
        station.substate = scene === "waiting" ? "waiting-on-person" : "stopped";
      }
    }
    if (scene === "maintenance" || scene === "refreshing") {
      environment.tone = scene === "maintenance" ? "bad" : "warn";
      environment.sub = scene === "maintenance" ? "held" : "refresh running · at deploy";
      assert(holds);
      holds.events.push({
        id: "capsule-hold",
        start: new Date(now - 2 * 86_400_000).toISOString(),
        state: "held",
        label: "2 d",
        detail: "in maintenance for 2 d so far",
      });
    }
    if (scene === "unread") {
      environment.figure = "?";
      for (const slot of visual.slots) slot.state = "unknown";
      for (const row of body.stations)
        for (const station of row.stations) station.state = "unknown";
    }
    if (scene === "sync") body.briefing.nextSyncAt = new Date(now + 6_000_000).toISOString();
    fixture(window, "view.snapshot", ViewSnapshotSchema.parse(body));
    const ready =
      scene === "waiting" || scene === "stopped"
        ? `document.querySelector('[data-strip] [data-field=forks]')?.title.includes(${JSON.stringify(scene)})`
        : scene === "maintenance" || scene === "refreshing"
          ? `document.querySelector('[data-strip] [data-field=environment]')?.title.includes(${JSON.stringify(scene === "maintenance" ? "Maintenance 2 d" : "refresh running")})`
          : scene === "unread"
            ? `document.querySelectorAll('[data-strip] .capsule-unread').length === 3`
            : scene === "sync"
              ? `document.querySelector('[data-strip] [data-field=next-sync]')`
              : `document.querySelectorAll('[data-strip] .capsule-ok').length === 3`;
    await rendered(window, ready);
    const bounds = await window.webContents.executeJavaScript(`(() => {
      const rect = document.querySelector('[data-strip]').getBoundingClientRect();
      return { x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
    })()`);
    const file = `capsule-${scene}-${appearance}.png`;
    writeFileSync(join(output, file), (await window.webContents.capturePage(bounds)).toPNG());
    images.push(
      `<figure><figcaption>${scene}</figcaption><img src="${file}" alt="${scene}"></figure>`,
    );
  }
  writeFileSync(
    join(output, `capsule-states-${appearance}.html`),
    `<!doctype html><meta charset="utf-8"><title>Capsule states</title><style>body{font:14px system-ui;padding:24px}figure{margin:24px 0}figcaption{margin-bottom:8px}</style><h1>Capsule / ${appearance}</h1>${images.join("")}`,
  );
}

async function settingsSection(
  window: BrowserWindow,
  section: "readiness" | "appearance" | "sweep",
): Promise<void> {
  await window.webContents.executeJavaScript(`{
    const picker = document.querySelector(".settings-picker select");
    if (picker) {
      picker.value = ${JSON.stringify(section)};
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      [...document.querySelectorAll(".settings-nav button")].find(item =>
        item.textContent === ${JSON.stringify({ appearance: "Appearance", readiness: "Readiness", sweep: "Sweep" }[section])}
      ).click();
    }
  }`);
  await rendered(window, `document.querySelector("[data-settings-section=${section}]")`);
}

async function shortcut(window: BrowserWindow, key: string): Promise<void> {
  await window.webContents.executeJavaScript(`{
    const mac = /Mac|iPhone|iPad/.test(navigator.userAgent);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, metaKey: mac, ctrlKey: !mac, bubbles: true }));
  }`);
}

async function openSettings(window: BrowserWindow): Promise<void> {
  await shortcut(window, ",");
  await rendered(window, 'document.querySelector("[role=dialog]")');
}

async function closeSettings(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(
    "document.querySelector(\"[aria-label='Close settings']\").click()",
  );
  await rendered(window, '!document.querySelector("[role=dialog]")');
}

/**
 * Shows the first push on Today in the foreground, leaves for Upstream, waits for the window's
 * own acknowledgement, then pushes the sweep that carries it. Returns the qualifier the report
 * checks; the caller returns to Today.
 */
async function leaveAcknowledged(
  window: BrowserWindow,
  load: () => Promise<void>,
  first: ViewSnapshot,
  acknowledged: ViewSnapshot,
  acknowledgements: number[],
): Promise<string> {
  await window.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", {
    enabled: true,
  });
  await load();
  await rendered(window, 'document.visibilityState === "visible" && document.hasFocus()');
  acknowledgements.length = 0;
  fixture(window, "view.snapshot", first);
  await rendered(window, 'document.querySelector(".today .place-reading")');
  await window.webContents.executeJavaScript('location.hash = "#upstream"');
  await rendered(window, 'document.querySelector("[data-place]")?.textContent === "Upstream"');
  const deadline = Date.now() + 5000;
  while (acknowledgements.length === 0 && Date.now() < deadline) await delay(20);
  assert.deepEqual(
    acknowledgements,
    [first.cursor],
    "Leaving Today must acknowledge the snapshot it showed",
  );
  assert.equal(acknowledged.seen.cursor, first.cursor, "Wrong acknowledged baseline");
  fixture(window, "view.snapshot", acknowledged);
  return `acknowledged ${acknowledgements[0]} · seen ${acknowledged.seen.cursor} · since ${acknowledged.seen.since.length}`;
}

async function measure(
  window: BrowserWindow,
  rule: SmokeGeometry["rule"],
  overlay = "",
  backdrop = "",
): Promise<SmokeGeometry> {
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
      case "sweep-visible": {
        const settings = document.querySelector("[data-settings-section=sweep]");
        const panel = settings ? element("[role=dialog].settings") : element("[data-sweep-header]").closest(".panel-body");
        const header = element(settings ? ".settings-header" : "[data-sweep-header]");
        const schedule = element(settings ? ".sweep-summary" : "[data-sweep-schedule]");
        return { rule: "sweep-visible", viewport, panel: rect(panel),
          elements: [header, schedule, header.querySelector(".sweep-now > button"),
            ...[...header.querySelectorAll(".sweep-now-status")].filter(item => item.textContent.trim())].filter(Boolean).map(rect) };
      }
      case "sweep-reads": {
        const picker = document.querySelector(".settings-picker select");
        return { rule: "sweep-reads", width: innerWidth,
          picker: picker && picker.getBoundingClientRect().width > 0 ? picker.selectedOptions[0].textContent : null,
          rows: [...document.querySelectorAll(".sweep-reads tbody tr")].map(row => {
            const cells = row.querySelectorAll("td");
            const label = row.querySelector(".mobile-label");
            return { name: rect(cells[0]), cadence: rect(cells[1]), lastRead: rect(cells[2]),
              label: getComputedStyle(label).display === "none" ? "" : label.textContent.trim() };
          }) };
      }
      case "failed-reads": {
        const section = element("[data-evidence=sweep] .evidence-failures");
        return { rule: "failed-reads", section: rect(section),
          panel: rect(section.closest(".panel-body")),
          rows: [...section.querySelectorAll(".evidence-failure")].map(row => ({
            source: row.querySelector(".sweep-name").textContent,
            outcome: row.querySelector(".sweep-outcome").textContent
          })) };
      }
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
        return { rule: "drag", services: Number(document.querySelector("[data-strip] [data-field=forks]")?.dataset.services ?? 0),
          appRegion: style.getPropertyValue("-webkit-app-region"),
          region: { x: bounds.x + left, y: bounds.y, width: bounds.width - left - right, height: 44 },
          targets: [...title.querySelectorAll("button, select, input, textarea, a, label, summary")]
            .filter(item => item.getBoundingClientRect().width > 0 && getComputedStyle(item).visibility !== "hidden").map(rect) };
      }
      case "overlay-drag": {
        const root = element(${JSON.stringify(overlay)});
        const box = rect(root);
        const left = Math.max(0, box.x), top = Math.max(0, box.y);
        const right = Math.min(innerWidth, box.x + box.width), bottom = Math.min(innerHeight, box.y + box.height);
        const regions = [...document.querySelectorAll("*")].flatMap(item => {
          const appRegion = getComputedStyle(item).getPropertyValue("-webkit-app-region");
          const bounds = rect(item);
          return (appRegion === "drag" || appRegion === "no-drag") && bounds.width > 0 && bounds.height > 0
            ? [{ appRegion, rect: bounds }] : [];
        });
        const targets = [...root.querySelectorAll("button, select, input, textarea, a[href], label, summary, [role=button], [role=option], [role=radio], [role=tab]")]
          .filter(item => getComputedStyle(item).visibility !== "hidden")
          .flatMap(item => {
            const bounds = rect(item);
            const x = Math.max(left, bounds.x), y = Math.max(top, bounds.y);
            const width = Math.min(right, bounds.x + bounds.width) - x;
            const height = Math.min(bottom, bounds.y + bounds.height) - y;
            const label = item.getAttribute("aria-label") || item.textContent.replace(/\\s+/g, " ").trim().slice(0, 40) || item.tagName.toLowerCase();
            return width > 0 && height > 0 ? [{ label, rect: { x, y, width, height } }] : [];
          });
        const result = { rule: "overlay-drag", overlay: ${JSON.stringify(overlay)}, viewport, regions, targets };
        if (${JSON.stringify(backdrop)}) {
          const shade = rect(element(${JSON.stringify(backdrop)}));
          const x = Math.max(0, shade.x), y = Math.max(0, shade.y);
          result.backdrop = { x, y, width: Math.min(innerWidth, shade.x + shade.width) - x, height: Math.min(innerHeight, shade.y + shade.height) - y };
        }
        return result;
      }
    }
  })()`);
  if (rule === "failed-reads") console.log(`Packaged failed reads: ${JSON.stringify(value)}`);
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

const OVERLAY_DRAG_SIZES = [
  ["minimum", 0, 560],
  ["launch", 900, 650],
  ["wide", 1440, 900],
] as const;

async function overlayDragProbe(
  window: BrowserWindow,
  output: string,
  load: () => Promise<void>,
): Promise<void> {
  const [minimumWidth] = window.getMinimumSize();
  assert(minimumWidth, "Missing window minimum width");
  const sizes = OVERLAY_DRAG_SIZES.map(
    ([size, width, height]) => [size, width || minimumWidth, height] as const,
  );
  const measured: (SmokeGeometry & { size: string; titleBar: number })[] = [];
  let rejected: string | undefined;
  let lap = Date.now();
  // One load serves all nine checks: each overlay stays open while the window resizes in place.
  const each = async (
    overlay: string,
    backdrop: string,
    order: typeof sizes,
    after?: (size: string) => Promise<void>,
  ) => {
    for (const [size, width, height] of order) {
      window.setContentSize(width, height);
      await rendered(
        window,
        `Math.abs(innerWidth - ${width}) <= 1 && Math.abs(innerHeight - ${height}) <= 1`,
      );
      const titleBar: number = await window.webContents.executeJavaScript(
        'document.querySelector(".title-bar").getBoundingClientRect().height',
      );
      let geometry: SmokeGeometry;
      try {
        geometry = await measure(window, "overlay-drag", overlay, backdrop);
      } catch (error) {
        console.log(`Packaged overlay drag ${size}/${overlay}: ${String(error)}`);
        throw error;
      }
      measured.push({ ...geometry, size, titleBar });
      assert(geometry.rule === "overlay-drag");
      const nearest = geometry.targets.reduce(
        (top, target) => Math.min(top, target.rect.y),
        Infinity,
      );
      const elapsed = Date.now() - lap;
      lap = Date.now();
      console.log(
        `Packaged overlay drag ${size}/${overlay}: title bar ${titleBar} px, ${geometry.targets.length} targets clear of ${geometry.regions.filter((region) => region.appRegion === "drag").length} drag rects${geometry.backdrop ? " with the backdrop" : ""}, top target y ${nearest}, ${elapsed} ms`,
      );
      await after?.(size);
    }
  };
  const [first] = sizes;
  assert(first);
  window.setContentSize(first[1], first[2]);
  await load();
  await window.webContents.executeJavaScript(
    'document.querySelector("[data-strip] [data-field=forks]").click()',
  );
  await rendered(window, 'document.querySelector(".line-sheet .line-grid")');
  await each(".line-sheet", "", sizes);
  await window.webContents.executeJavaScript(
    "document.querySelector(\"[aria-label='Close Line']\").click()",
  );
  await rendered(window, '!document.querySelector(".line-sheet")');
  await openSettings(window);
  await each("[role=dialog].settings", ".settings-backdrop", [...sizes].reverse(), async (size) => {
    writeFileSync(
      join(output, `overlay-drag-settings-${size}.png`),
      (await window.webContents.capturePage()).toPNG(),
    );
    if (size !== "minimum") return;
    const unprotected =
      '[".settings", ".settings-backdrop"].map((item) => document.querySelector(item).style)';
    await window.webContents.executeJavaScript(
      `${unprotected}.forEach((style) => style.setProperty("-webkit-app-region", "unset"))`,
    );
    try {
      await measure(window, "overlay-drag", "[role=dialog].settings", ".settings-backdrop");
      assert.fail("Settings inside the drag shape passed");
    } catch (error) {
      if (
        !(error instanceof AssertionError) ||
        !/Close settings at .*; backdrop at .* in a drag rectangle$/.test(error.message)
      )
        throw error;
      rejected = error.message;
      console.log(`Packaged broken-rule proof rejected: ${error.message}`);
    } finally {
      await window.webContents.executeJavaScript(
        `${unprotected}.forEach((style) => style.removeProperty("-webkit-app-region"))`,
      );
    }
  });
  await closeSettings(window);
  await shortcut(window, "k");
  await rendered(window, 'document.querySelector("[role=dialog].palette")');
  await each("[role=dialog].palette", ".palette-backdrop", sizes);
  assert(rejected, "Missing packaged overlay drag broken-rule proof");
  writeFileSync(
    join(output, "overlay-drag.json"),
    `${JSON.stringify({ measured, rejected }, null, 2)}\n`,
  );
}

export async function captureSmokeViews(
  window: BrowserWindow,
  reportPath: string,
  fixturePath: string,
  designPath: string,
  morningPaths: Readonly<Record<Morning, string>>,
): Promise<SmokeShot[]> {
  const snapshot = ViewSnapshotSchema.parse(JSON.parse(readFileSync(fixturePath, "utf8")));
  const acknowledged = ViewSnapshotSchema.parse(
    JSON.parse(readFileSync(join(dirname(fixturePath), "generated", ACKNOWLEDGED_FIXTURE), "utf8")),
  );
  assert(
    acknowledged.sweptAt === snapshot.sweptAt && acknowledged.cursor > snapshot.cursor,
    "The acknowledged fixture must push the Nov 6 sweep again",
  );
  const mornings = loadMornings(morningPaths);
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
  const acknowledgements: number[] = [];
  const request = (event: Electron.IpcMainEvent, input: unknown) => {
    if (event.sender !== window.webContents) return;
    const parsed = parseMessage(input);
    assert(parsed.ok, "Invalid renderer smoke request");
    const message = parsed.message;
    if (message.type === "view.acknowledge") acknowledgements.push(message.payload.cursor);
    else if (message.type === "setup.signin") {
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
        let scheduledCursor = snapshot.cursor + 2;
        for (const surface of surfaces) {
          const scheduled =
            surface.id.startsWith("settings-sweep-") || surface.id.startsWith("evidence-header-");
          if (scheduled) {
            const state = surface.id.endsWith("saved-failure")
              ? "saved-failure"
              : surface.id.endsWith("not-ready")
                ? "not-ready"
                : surface.id.endsWith("sweeping")
                  ? "sweeping"
                  : "idle";
            const scheduledSweep = smokeScheduledSweep(snapshot, state);
            await window.webContents.executeJavaScript(
              `void (Date.now = () => ${scheduledSweep.now})`,
            );
            fixture(window, "setup.state", ready);
            fixture(window, "view.snapshot", {
              ...scheduledSweep.snapshot,
              cursor: scheduledCursor++,
            });
            fixture(window, "sweep.progress", scheduledSweep.completed);
            if (scheduledSweep.progress !== scheduledSweep.completed)
              fixture(window, "sweep.progress", scheduledSweep.progress);
            fixture(window, "sweep.status", scheduledSweep.status);
            await rendered(window, 'document.querySelector(".today .place-reading")');
            if (surface.id === "evidence-header-idle") {
              await window.webContents.executeJavaScript(
                'document.querySelector("[data-sweep-line]").click()',
              );
            }
          }
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
          const seen =
            surface.id === "today-acknowledged"
              ? await leaveAcknowledged(
                  window,
                  async () => {
                    await window.webContents.executeJavaScript(`{
                      localStorage.removeItem("spi-code.panes");
                      localStorage.removeItem("spi-code.line-sheet.pinned");
                      location.hash = "#today";
                    }`);
                    const loaded = once(window.webContents, "did-finish-load");
                    window.webContents.reload();
                    await loaded;
                    await rendered(
                      window,
                      'document.querySelector(".shell [data-sidebar-row=settings]")',
                    );
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
                  },
                  snapshot,
                  acknowledged,
                  acknowledgements,
                )
              : undefined;
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
                'document.querySelector("[data-sweep-line] .evidence-dot[data-spin]")',
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
              'document.querySelector("[data-strip] [data-field=forks]").click()',
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
            if (!surface.id.startsWith("settings-sweep-") || surface.id === "settings-sweep-idle")
              await openSettings(window);
            await settingsSection(
              window,
              surface.id.startsWith("settings-sweep-")
                ? "sweep"
                : surface.id === "settings-appearance"
                  ? "appearance"
                  : "readiness",
            );
            if (surface.id === "settings-sweep-not-ready")
              fixture(window, "setup.state", {
                ...ready,
                watchReady: false,
                disabledReason: "Watch needs gh.",
                tools: ready.tools.map((tool) =>
                  tool.tool === "gh" ? { tool: "gh", state: "signed-out", action: "signin" } : tool,
                ),
              });
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
          if (surface.id === "strip" || surface.id === "strip-20") {
            await rendered(
              window,
              `[
              "environment", "template", "forks", "freshness"
            ].every(field => document.querySelector('[data-strip] [data-field="' + field + '"]'))`,
            );
          }
          if (scheduled) {
            await window.webContents.executeJavaScript(`{
              const settings = document.querySelector("[data-settings-section=sweep]");
              const panel = settings ?? document.querySelector("[data-sweep-header]").closest(".panel-body");
              panel.scrollTop = 0;
            }`);
            await rendered(window, "true");
            const disabled = await window.webContents.executeJavaScript(
              `document.querySelector(${JSON.stringify(
                surface.id.startsWith("settings-sweep-")
                  ? "[role=dialog].settings"
                  : "[data-sweep-header]",
              )})?.querySelector(".sweep-now > button")?.disabled ?? null`,
            );
            assert.equal(
              disabled,
              surface.id === "evidence-header-sweeping"
                ? null
                : !surface.id.endsWith("-idle") && !surface.id.endsWith("-saved-failure"),
              `Wrong Sweep now availability: ${surface.id}`,
            );
          }
          if (surface.id === "first-sweep-evidence") {
            await rendered(
              window,
              'document.querySelector("[data-evidence=sweep] .evidence-failure")',
            );
            await window.webContents.executeJavaScript(
              'document.querySelector("[data-evidence=sweep] .evidence-failures").scrollIntoView({ block: "center" })',
            );
            await rendered(window, "true");
          }
          const geometry = [];
          for (const rule of geometryRules(surface.id, viewportWidth)) {
            if (rule === "overlay-drag") {
              const settings = surface.id.startsWith("settings-sweep-");
              const backdrop = settings
                ? ".settings-backdrop"
                : await window.webContents.executeJavaScript(
                    'document.querySelector(".detail-backdrop") ? ".detail-backdrop" : ""',
                  );
              geometry.push(
                await measure(
                  window,
                  rule,
                  settings ? "[role=dialog].settings" : ".right-panel-frame",
                  backdrop,
                ),
              );
            } else geometry.push(await measure(window, rule));
          }
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
              surface.id.startsWith("settings-sweep-")
                ? "[role=dialog].settings"
                : surface.id.startsWith("evidence-header-")
                  ? "[data-sweep-header]"
                  : surface.id === "first-sweep-evidence"
                    ? "[data-evidence=sweep]"
                    : surface.id === "first-sweep-place"
                      ? ".place-before-sweep"
                      : surface.id.startsWith("first-sweep-") &&
                          surface.id !== "first-sweep-refresh"
                        ? ".today-first"
                        : "main :is(.place-qualifier, .today-caveat)",
            )})?.innerText?.replace(/\\s+/g, " ").trim() ?? ""
          ]`);
          if (seen !== undefined)
            qualifiers.push(
              ...(await window.webContents.executeJavaScript(`[
                document.querySelector(".today .today-headline")?.textContent.trim() ?? "",
                document.querySelector('ul[aria-label="Today"] .sidebar-pip')?.textContent.trim() ?? "",
                String(document.querySelectorAll(".today .today-needs .today-need, .today .today-stop").length)
              ]`)),
              seen,
            );
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
          if (seen !== undefined)
            await window.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", {
              enabled: false,
            });
          if (surface.id.startsWith("settings")) {
            if (surface.id === first.id)
              fixture(window, "setup.signin.progress", {
                tool: "gh",
                requestId: ghRequest,
                state: "completed",
              });
            fixture(window, "setup.state", ready);
            if (!scheduled || surface.id === "settings-sweep-not-ready")
              await closeSettings(window);
          }
          if (surface.id === "line" || surface.id === "panes")
            await window.webContents.executeJavaScript(
              "document.querySelector(\"[aria-label='Close Line']\").click()",
            );
          if (
            surface.id === "evidence-header-sweeping" ||
            ["detail", "detail-related", "panes", "first-sweep-evidence"].includes(surface.id)
          )
            await window.webContents.executeJavaScript(
              "document.querySelector(\"[aria-label='Close detail']\").click()",
            );
        }
        if (viewportWidth === 1440) {
          fixture(window, "sweep.progress", progress.committed);
          await captureCapsuleStates(
            window,
            snapshot,
            output,
            appearance,
            Date.parse(checkedAt),
            scheduledCursor + 100,
          );
        }
      }
    }
    shots.push(
      ...(await captureMornings(
        {
          window,
          output,
          rendered: (condition) => rendered(window, condition),
          fixture: (type, payload) => fixture(window, type, payload),
          measure: (rule) => measure(window, rule),
          sweepStatus: {
            remaining: 4865,
            floor: 100,
            resetAt: "2026-11-06T15:36:00.000Z",
            deferredAreas: [],
            nextSweepAt: null,
            schedule: sweepSchedule,
            lastSweep: null,
          },
          setupState: ready,
        },
        mornings,
      )),
    );
    assertSmokeViews(shots);
    await overlayDragProbe(window, output, async () => {
      await window.webContents.executeJavaScript(`{
        localStorage.removeItem("spi-code.panes");
        localStorage.removeItem("spi-code.line-sheet.pinned");
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
      fixture(window, "setup.state", ready);
      await rendered(window, 'document.querySelector(".today .place-reading")');
    });
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
Appearance pinned in the app. Fixture clock: Nov 6, 09:04 America/Chicago, except scheduled
Sweep surfaces: idle and not-ready at 08:04, sweeping at 08:08, saved-with-failure at 09:04.
Setup sign-ins are intercepted fixtures, never live authentication. Related and 20-service probes vary the projection.
First-sweep surfaces inject schema-valid sweep.progress messages through the same smoke-only preload channel as
view.snapshot and setup.state. This screenshot phase precedes host startup, so it cannot feed the real host progress path;
the persisted-snapshot and supervision host proof runs separately, after these fixtures are removed.
Only view.snapshot hands over the first-sweep list; the refresh preserves the older brief.
Today after acknowledgement shows the Nov 6 projection in the foreground, leaves for Upstream, waits for
the window's own view.acknowledge, receives that sweep pushed again with the acknowledged baseline
(${ACKNOWLEDGED_FIXTURE}: nothing new since, its Interrupt still open) and comes back to Today.
Settings / Sweep and the Evidence header use schema-valid sweep.status, sweep.progress and
view.snapshot fixtures. Each named header, schedule line and Sweep now control must be inside
its panel and viewport. At 740 px the native picker must select Sweep and every cadence and
last-read cell must sit below its source, with the last-read label visible.
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
<h1>Today on three mornings</h1><p>Each morning is a schema-valid snapshot shown through the same smoke-only
preload channel, at the Nov 6 fixture clock: ${MORNING_SURFACES.filter(({ detail }) => !detail)
      .map(({ morning }) => `${morning} from ${mornings[morning].fixture}`)
      .join(", ")}.
Each image is the whole Today frame: the window is 800 px tall, and Today's pane is captured strip by
strip as it scrolls and joined, so blocks below the fold (Releases, In motion) are in the image. Beside the
pane, the sidebar and Detail continue their last row below the window's height. The blocks line
under each image is the DOM evidence: each block's top and height in the image, in CSS pixels.
Detail open selects the first released version, which opens from the snapshot alone.
Design: decision.md, draft 7 (approved 2026-11-10), and its aligned mock. Record match or mismatch per
surface against the sections named under it.</p>
${MORNING_SURFACES.map(
  (
    surface,
  ) => `<section><h2>Today, ${surface.morning} morning${surface.detail ? ", Detail open" : ""}</h2>
${surface.widths
  .map((width) => {
    const row = ["light", "dark"].map((appearance) =>
      shots.find(
        (shot) =>
          shot.surface === surface.id &&
          shot.viewportWidth === width &&
          shot.appearance === appearance,
      ),
    );
    const evidence = row[0]?.morning;
    return `<h3>${width} px</h3><p>decision.md: ${evidence?.sections.join("; ") ?? ""}</p>
<p>Headline: ${escapeHtml(evidence?.headline ?? "")}${row[0]?.qualifiers[1] ? `<br>Caveat band: ${escapeHtml(row[0].qualifiers[1])}` : ""}${evidence?.detailTitle ? `<br>Detail: ${escapeHtml(evidence.detailTitle)}` : ""}</p>
<table><tr><th>Light</th><th>Dark</th></tr><tr>${row
      .map((shot) => {
        const file = shot?.file.slice("views/".length) ?? "";
        return `<td><a href="${file}"><img alt="Today, ${surface.morning}, ${width} px, ${shot?.appearance}" src="${file}"></a><p>Page ${shot?.morning?.pageHeight} px of a ${shot?.morning?.viewportHeight} px window. Blocks: ${shot?.morning?.blocks.map(({ name, top, height }) => `${name} ${Math.round(top)}+${Math.round(height)}`).join(", ")}</p></td>`;
      })
      .join("")}</tr></table>`;
  })
  .join("")}</section>`,
).join("\n")}
</html>\n`,
  );
  return shots;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
}
