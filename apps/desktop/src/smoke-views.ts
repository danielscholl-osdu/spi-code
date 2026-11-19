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
import {
  ENVIRONMENT_BACK,
  ENVIRONMENT_BORROW,
  ENVIRONMENT_HOLD,
  ENVIRONMENT_INSIDE_NOW,
  ENVIRONMENT_LINK,
  ENVIRONMENT_LIVE,
  ENVIRONMENT_OVERLAP,
  ENVIRONMENT_WEEK,
  ENVIRONMENT_YESTERDAY,
  environmentYesterdayUpgrade,
  recordedChicagoSnapshot,
  SMOKE_TIME_ZONE,
  smokeEnvironment,
} from "./smoke-environment.js";
import { captureForks } from "./smoke-forks.js";
import { assertSmokeGeometry, type SmokeGeometry } from "./smoke-geometry.js";
import {
  DRAWN_MEMBERS,
  lineMembersText,
  MORNING_SURFACES,
  type Morning,
  membersText,
} from "./smoke-mornings.js";
import {
  assertSmokeShot,
  assertSmokeViews,
  BROKEN_PROOFS,
  geometryRules,
  type SmokeShot,
  VIEW_SURFACES,
  VIEW_WIDTHS,
} from "./smoke-report.js";
import { captureRepositories } from "./smoke-repositories.js";
import { captureRollout } from "./smoke-rollout.js";
import { withServiceLists } from "./smoke-service-lists.js";
import { withSmokeServiceRuns } from "./smoke-service-runs.js";
import { captureSidebarPins } from "./smoke-sidebar.js";
import { smokeScheduledSweep, smokeSweepProgress } from "./smoke-sweep.js";
import { captureMornings, loadMornings } from "./smoke-today.js";
import { captureTopRowPins, PIN_END_PROBE } from "./smoke-top-row.js";

const sweepSchedule = {
  sweepMs: 300_000,
  gitlabMs: 1_800_000,
  securityMs: 1_800_000,
  releasesMs: 3_600_000,
};

const BRIEF_HTML = `(() => {
  const today = document.querySelector(".today").cloneNode(true);
  [...today.querySelectorAll(".today-caveat-actions button")]
    .find(button => button.textContent.trim() === "Read again")?.removeAttribute("disabled");
  return today.outerHTML;
})()`;

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

/**
 * A screencast keeps the hidden window drawing at the display rate. Unwatched on Windows, it soon
 * draws one frame a second, and each `rendered` wait for two painted frames then costs two seconds.
 */
async function keepDrawing(window: BrowserWindow): Promise<() => Promise<void>> {
  const debug = window.webContents.debugger;
  const ack = (_event: Electron.Event, method: string, params: { sessionId?: number }) => {
    if (method === "Page.screencastFrame")
      debug.sendCommand("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
  };
  debug.on("message", ack);
  await debug.sendCommand("Page.startScreencast", { format: "png", maxWidth: 64, maxHeight: 64 });
  return async () => {
    await debug.sendCommand("Page.stopScreencast");
    debug.removeListener("message", ack);
  };
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

function templateFigure(body: ViewSnapshot) {
  const door = body.briefing.today?.fleet?.doors.find(({ id }) => id === "template");
  assert(door, "Status captures need the Template door");
  return door;
}

function clearUpstreamMark(body: ViewSnapshot) {
  for (const line of body.briefing.lines ?? [])
    for (const member of line.members) if (member.home === "upstream") delete member.home;
}

async function captureStatusStates(
  window: BrowserWindow,
  snapshot: ViewSnapshot,
  output: string,
  appearance: string,
  now: number,
  cursor: number,
): Promise<void> {
  const scenes = [
    "fine",
    "template-review",
    "upstream-work",
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
    const environment = body.briefing.environment.facts.find(({ label }) => label === "Running");
    assert(environment);
    environment.tone = "ok";
    environment.sub = "ready";
    body.briefing.environment.deployable = "yes";
    const holds = body.briefing.environment.lanes.find(({ id }) => id === "holds");
    if (holds) holds.events = [];
    const template = templateFigure(body);
    if (scene !== "template-review") Object.assign(template, { count: 0, forks: [] });
    if (scene !== "upstream-work") clearUpstreamMark(body);
    if (scene === "maintenance" || scene === "refreshing") {
      body.briefing.environment.deployable = "no";
      environment.tone = scene === "maintenance" ? "bad" : "warn";
      environment.sub = scene === "maintenance" ? "held" : "refresh running · at deploy";
      assert(holds);
      holds.events.push({
        id: "status-hold",
        start: new Date(now - 2 * 86_400_000).toISOString(),
        state: "held",
        label: "2 d",
        detail: "in maintenance for 2 d so far",
      });
    }
    if (scene === "unread") {
      environment.figure = "?";
      template.notRead = ["file"];
    }
    if (scene === "sync") body.briefing.nextSyncAt = new Date(now + 6_000_000).toISOString();
    fixture(window, "view.snapshot", ViewSnapshotSchema.parse(body));
    const pin = (status: string, classification: string) =>
      `document.querySelector('[data-status=${status}][data-classification=${classification}]')`;
    const ready = {
      fine: `${pin("environment", "fine")} && ${pin("template", "fine")}`,
      "template-review": `${pin("template", "pending")}?.title.includes("to review")`,
      "upstream-work": `${pin("upstream", "pending")}?.title.includes("on Upstream")`,
      maintenance: `${pin("environment", "maintenance")}?.title.includes("Maintenance 2 d")`,
      refreshing: `${pin("environment", "refreshing")}?.title.includes("refresh running")`,
      unread: `${pin("environment", "unread")} && ${pin("template", "unread")}`,
      sync: `${pin("next-sync", "soon")}?.title.startsWith("Next upstream sync")`,
    }[scene];
    await rendered(window, ready);
    const sidebar = await window.webContents.executeJavaScript(`(() => {
      const rect = document.querySelector('#app-sidebar[data-state=expanded]')?.getBoundingClientRect();
      return rect && { x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
    })()`);
    assert(sidebar?.width > 0, `The sidebar is out of sight in the ${scene} status scene`);
    const sidebarFile = `sidebar-status-${scene}-${appearance}.png`;
    writeFileSync(
      join(output, sidebarFile),
      (await window.webContents.capturePage(sidebar)).toPNG(),
    );
    images.push(
      `<figure><figcaption>${scene}</figcaption><img src="${sidebarFile}" alt="${scene} sidebar"></figure>`,
    );
  }
  writeFileSync(
    join(output, `sidebar-status-states-${appearance}.html`),
    `<!doctype html><meta charset="utf-8"><title>Sidebar status states</title><style>body{font:14px system-ui;padding:24px}figure{margin:24px 0}figcaption{margin-bottom:8px}</style><h1>Sidebar status / ${appearance}</h1>${images.join("")}`,
  );
}

async function captureSweepStates(
  window: BrowserWindow,
  snapshot: ViewSnapshot,
  progress: ReturnType<typeof smokeSweepProgress>,
  output: string,
  appearance: string,
  now: number,
  cursor: number,
): Promise<void> {
  const scenes = [
    "idle",
    "stale",
    "failed",
    "sweeping",
    "popover",
    "sweeping-hidden",
    "failed-hidden",
    "stale-hidden",
  ] as const;
  const images: string[] = [];
  await window.webContents.executeJavaScript(`void (Date.now = () => ${now})`);
  fixture(window, "sweep.status", {
    remaining: 4865,
    floor: 100,
    resetAt: "2026-11-06T15:36:00.000Z",
    deferredAreas: [],
    nextSweepAt: new Date(now + 5 * 60_000).toISOString(),
    schedule: sweepSchedule,
    lastSweep: null,
  });
  for (const scene of scenes) {
    const state = scene.replace("-hidden", "");
    const hidden = scene.endsWith("-hidden");
    const body = structuredClone(snapshot);
    body.cursor = cursor++;
    if (state === "idle" || state === "stale" || hidden) {
      const fresh = (source: string) => ({
        source,
        state: "fresh" as const,
        observedAt: body.sweptAt,
        completeness: { kind: "complete" as const },
      });
      body.areas = body.areas.map(({ area }) => ({ area, envelope: fresh(area) }));
      body.provenance = body.provenance.map((entry) =>
        entry.envelope ? { ...entry, envelope: fresh(entry.envelope.source) } : entry,
      );
      const runs = body.areas.find(({ area }) => area === "runs");
      if (runs && (state === "stale" || state === "failed"))
        runs.envelope = { ...fresh("runs"), state: state === "stale" ? "stale" : "failed" };
    }
    if (hidden) {
      for (const item of [...body.briefing.focus, ...body.briefing.rest])
        item.attention = "ambient";
      clearUpstreamMark(body);
      Object.assign(templateFigure(body), { count: 0, forks: [] });
    }
    fixture(window, "view.snapshot", ViewSnapshotSchema.parse(body));
    fixture(window, "sweep.progress", state === "sweeping" ? progress.refresh : progress.committed);
    const tone = { idle: "fine", stale: "warn", failed: "bad", sweeping: "run", popover: "bad" }[
      state as "idle" | "stale" | "failed" | "sweeping" | "popover"
    ];
    await rendered(
      window,
      `document.querySelector('[data-slot=sidebar-footer] [data-sweep-line][data-tone=${tone}]') && ${state === "sweeping" ? "" : "!"}document.querySelector('[data-sweep-progress]')`,
    );
    if (hidden) {
      await window.webContents.executeJavaScript(
        "document.querySelector(\"[aria-label='Toggle sidebar']\").click()",
      );
      await rendered(window, 'document.querySelector("#app-sidebar[data-state=collapsed]")');
      const dot = await window.webContents.executeJavaScript(
        'document.querySelector(".sidebar-toggle-dot")?.dataset.tone ?? null',
      );
      assert.equal(
        dot,
        state === "failed" ? "error" : state === "stale" ? "warning" : null,
        `Hidden sidebar must read only the ${state} sweep's tone`,
      );
    }
    if (scene === "popover") {
      await window.webContents.executeJavaScript(
        "document.querySelector('[data-slot=sidebar-footer] [data-sweep-line]').click()",
      );
      await rendered(window, "document.querySelector('[data-sweep-popover] .capsule-evidence')");
    }
    const bounds = await window.webContents.executeJavaScript(`(() => {
      if (${hidden}) return { x: 0, y: 0, width: innerWidth, height: innerHeight };
      const rects = [document.querySelector('[data-slot=sidebar-footer]'),
        document.querySelector('[data-sweep-popover]')].filter(Boolean).map(item => item.getBoundingClientRect());
      const top = Math.min(...rects.map(rect => rect.top));
      const bottom = Math.max(...rects.map(rect => rect.bottom));
      return { x: 0, y: Math.floor(top), width: innerWidth, height: Math.min(innerHeight, Math.ceil(bottom)) - Math.floor(top) };
    })()`);
    const file = `sweep-${scene}-${appearance}.png`;
    writeFileSync(join(output, file), (await window.webContents.capturePage(bounds)).toPNG());
    if (hidden) {
      await window.webContents.executeJavaScript(
        "document.querySelector(\"[aria-label='Toggle sidebar']\").click()",
      );
      await rendered(window, 'document.querySelector("#app-sidebar[data-state=expanded]")');
    }
    images.push(
      `<figure><figcaption>${scene}</figcaption><img src="${file}" alt="${scene}"></figure>`,
    );
    if (scene === "popover") {
      await window.webContents.executeJavaScript(
        "document.querySelector('[data-slot=sidebar-footer] [data-sweep-line]').click()",
      );
      await rendered(window, "!document.querySelector('[data-sweep-popover]')");
    }
  }
  writeFileSync(
    join(output, `sweep-states-${appearance}.html`),
    `<!doctype html><meta charset="utf-8"><title>Sweep states</title><style>body{font:14px system-ui;padding:24px}figure{margin:24px 0}figcaption{margin-bottom:8px}img{max-width:100%}</style><h1>Footer sweep / ${appearance}</h1><p>Design: spicode-e2z footer sweep and its sources popover.</p>${images.join("")}`,
  );
}

const PINS_KEY = "spi-code.sidebar.pins.v3";

/**
 * Find or ask with Environment and Template in the sidebar's fixed block, Upstream
 * and entitlements pinned, and the unpinned partition highlighted, so its hollow pin shows.
 */
async function captureFindPins(
  window: BrowserWindow,
  output: string,
  appearance: string,
): Promise<void> {
  const key = JSON.stringify(PINS_KEY);
  const saved: string | null = await window.webContents.executeJavaScript(
    `localStorage.getItem(${key})`,
  );
  const pins = ["place:upstream", "entitlements"];
  const store = (value: string | null) =>
    window.webContents.executeJavaScript(`{
      const value = ${JSON.stringify(value)};
      value === null ? localStorage.removeItem(${key}) : localStorage.setItem(${key}, value);
      window.dispatchEvent(new StorageEvent("storage", { key: ${key} }));
    }`);
  await store(JSON.stringify(pins));
  try {
    await shortcut(window, "k");
    // Message-channel turns, not timers or frames, which the hidden window throttles on Windows.
    await window.webContents.executeJavaScript(`(async () => {
      const turn = () => new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = resolve;
        channel.port2.postMessage(0);
      });
      const input = () => document.querySelector("[role=dialog].palette [data-pin-state]") &&
        document.querySelector("[role=dialog].palette input");
      const label = () => document.querySelector(".palette-row[data-highlighted] .palette-label")?.textContent;
      for (let step = 0; step < 200 && !input(); step++) await turn();
      for (let step = 0; step < 30 && label() !== "partition"; step++) {
        input()?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        await turn();
      }
    })()`);
    await rendered(
      window,
      'document.querySelector(".palette-row[data-highlighted][data-pin-state=unpinned] .palette-label")?.textContent === "partition" && document.querySelector(".palette-row[data-pin-state=always]") && document.querySelector(".palette-row[data-pin-state=pinned]")',
    );
    const bounds = await window.webContents.executeJavaScript(`(() => {
      const rect = document.querySelector("[role=dialog].palette").getBoundingClientRect();
      return { x: Math.floor(rect.x) - 8, y: Math.floor(rect.y) - 8, width: Math.ceil(rect.width) + 16, height: Math.ceil(rect.height) + 16 };
    })()`);
    const file = `find-pins-${appearance}.png`;
    writeFileSync(join(output, file), (await window.webContents.capturePage(bounds)).toPNG());
    writeFileSync(
      join(output, `find-pins-${appearance}.html`),
      `<!doctype html><meta charset="utf-8"><title>Find or ask pins</title><style>body{font:14px system-ui;padding:24px}img{max-width:100%}</style><h1>Find or ask pins / ${appearance}</h1><p>Design: epic spicode-1l9 and its rulings. Environment and Template sit in the sidebar's fixed block and draw no pin control; Upstream and entitlements are pinned (filled); partition is highlighted and unpinned (hollow).</p><img src="${file}" alt="Find or ask with pinned and unpinned results and the fixed block's places">`,
    );
    await window.webContents.executeJavaScript(
      'document.querySelector("[role=dialog].palette input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))',
    );
  } finally {
    await store(saved);
  }
}

/** The sweep segment opens a popover; its Evidence opens the sweep's Evidence page. */
async function openSweepEvidence(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript('document.querySelector("[data-sweep-line]").click()');
  await rendered(window, 'document.querySelector("[data-sweep-popover] .capsule-evidence")');
  await window.webContents.executeJavaScript(
    'document.querySelector("[data-sweep-popover] .capsule-evidence").click()',
  );
  await rendered(
    window,
    '!document.querySelector("[data-sweep-popover]") && location.hash.startsWith("#evidence") && document.querySelector("[data-evidence-page] [data-evidence=sweep]") && document.querySelector("[data-place]")?.textContent === "Evidence"',
  );
}

/** Back on the Evidence page returns to the place it was opened from. */
async function leaveEvidence(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(
    'document.querySelector("[data-evidence-page] [data-evidence-back]").click()',
  );
  await rendered(window, '!document.querySelector("[data-evidence-page]")');
}

/**
 * The platform's back and forward keys, sent through Chromium's input path rather than a
 * synthetic DOM event, move the window's own history once each.
 */
async function historyKeys(window: BrowserWindow, restore: () => void): Promise<void> {
  const [back, forward] =
    process.platform === "darwin"
      ? (["[", "]"] as const).map((keyCode) => ({ keyCode, modifiers: ["meta" as const] }))
      : (["Left", "Right"] as const).map((keyCode) => ({ keyCode, modifiers: ["alt" as const] }));
  const press = (key: typeof back) => {
    assert(key);
    window.webContents.sendInputEvent({ type: "keyDown", ...key });
    window.webContents.sendInputEvent({ type: "keyUp", ...key });
  };
  const place = (hash: string, label: string) =>
    rendered(
      window,
      `location.hash === ${JSON.stringify(hash)} && document.querySelector("[data-place]")?.textContent === ${JSON.stringify(label)}`,
    );
  await window.webContents.executeJavaScript(
    'document.activeElement?.blur(); location.hash = "#security"',
  );
  await place("#security", "Security");
  await window.webContents.executeJavaScript('location.hash = "#releases"');
  await place("#releases", "Releases");
  press(back);
  await place("#security", "Security");
  press(forward);
  await place("#releases", "Releases");
  press(back);
  await place("#security", "Security");
  const loaded = once(window.webContents, "did-finish-load");
  window.webContents.reload();
  await loaded;
  await rendered(window, 'document.querySelector(".shell [data-sidebar-row=settings]")');
  restore();
  await place("#security", "Security");
  const history = window.webContents.navigationHistory;
  assert(history.canGoForward(), "Reload must leave the old forward entry in Chromium");
  const index = history.getActiveIndex();
  press(forward);
  await delay(250);
  assert.equal(history.getActiveIndex(), index, "Forward must stay inside the current launch");
  await place("#security", "Security");
}

async function captureSettled(window: BrowserWindow, condition: string, path: string) {
  await rendered(window, condition);
  await rendered(window, condition);
  const frame = await window.webContents.capturePage();
  assert(await window.webContents.executeJavaScript(`Boolean(${condition})`), path);
  writeFileSync(path, frame.toPNG());
}

async function captureFindToday(window: BrowserWindow, path: string) {
  const list = 'document.querySelector(".palette-results")';
  const blocked = `${list}?.querySelector('[data-group="blocked"] .palette-group')`;
  await shortcut(window, "k");
  await rendered(window, blocked);
  await window.webContents.executeJavaScript(`{
    const list = ${list};
    list.scrollTop += ${blocked}.getBoundingClientRect().top - list.getBoundingClientRect().top - 6;
  }`);
  const visibleGroups = `(() => {
    const list = ${list};
    if (!list) return false;
    const bounds = list.getBoundingClientRect();
    return ["blocked", "waiting", "can-wait"].every(id => {
      const group = list.querySelector('[data-group="' + id + '"]');
      const head = group?.querySelector(".palette-group").getBoundingClientRect();
      const row = group?.querySelector(".palette-row").getBoundingClientRect();
      return head?.top >= bounds.top && row?.bottom <= bounds.bottom;
    });
  })()`;
  await captureSettled(window, visibleGroups, path);
  await shortcut(window, "k");
  await rendered(window, `!${list}`);
}

async function captureSweepRulings(
  window: BrowserWindow,
  retained: ViewSnapshot,
  recorded: ViewSnapshot,
  output: string,
  appearance: string,
  cursor: number,
) {
  const show = async (snapshot: ViewSnapshot, cursor: number, hash: string) => {
    fixture(window, "view.snapshot", { ...snapshot, cursor });
    await window.webContents.executeJavaScript(`{
      Date.now = () => ${Date.parse(snapshot.sweptAt)};
      location.hash = ${JSON.stringify(hash)};
    }`);
  };
  await show(retained, cursor, "#service/search/pulls");
  const search = '.service-page[aria-label="search"]';
  await captureSettled(
    window,
    `document.querySelector('${search} [data-work="pr"] .service-list-unread') &&
      document.querySelector('${search} [data-work="pr"] [data-row="507"]') &&
      document.querySelector('${search} [data-tab="pulls"] .service-tab-count')?.textContent === "2 ⌀"`,
    join(output, `service-pulls-retained-${appearance}.png`),
  );
  await window.webContents.executeJavaScript('location.hash = "#service/search"');
  await captureSettled(
    window,
    `document.querySelector('${search} [data-tab="overview"][aria-selected="true"]') &&
      document.querySelector('${search} [data-door="unread"]')`,
    join(output, `service-doors-incomplete-${appearance}.png`),
  );
  await show(recorded, cursor + 1, "#service/entitlements");
  await captureSettled(
    window,
    `document.querySelector('.service-page[aria-label="entitlements"] [data-station="upstream"][data-state="stopped"] .flow-word')?.textContent === "Sync halted"`,
    join(output, `service-sync-halted-${appearance}.png`),
  );
  await window.webContents.executeJavaScript('location.hash = "#today"');
  const port = "document.querySelector('.today [data-line-id=\"waiting:port:entitlements\"]')";
  await rendered(window, port);
  await window.webContents.executeJavaScript(`${port}.scrollIntoView({ block: "center" })`);
  await captureSettled(
    window,
    `(() => {
      const row = ${port};
      const rect = row?.getBoundingClientRect();
      return rect && rect.top >= 0 && rect.bottom <= innerHeight;
    })()`,
    join(output, `today-port-${appearance}.png`),
  );
  await captureFindToday(window, join(output, `find-today-${appearance}.png`));
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
        const panel = settings ? element("[role=dialog].settings") : element("[data-evidence-page]");
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
          panel: rect(section.closest("[data-evidence-page]")),
          rows: [...section.querySelectorAll(".evidence-failure")].map(row => ({
            source: row.querySelector(".sweep-name").textContent,
            outcome: row.querySelector(".sweep-outcome").textContent
          })) };
      }
      case "window":
        return { rule: "window", viewport, scroll,
          rightPanels: document.querySelectorAll("#app-right-panel").length,
          panelToggles: document.querySelectorAll("[aria-controls=app-right-panel], [aria-label='Toggle right panel'], [aria-label='Close detail']").length,
          panes: [...document.querySelectorAll(".app-sidebar:not([inert]), .middle-frame, .right-panel-frame")].map(rect) };
      case "related":
        return { rule: "related", panel: rect(element(".popover")),
          label: rect(element(".popover-fields dt")), labelText: element(".popover-fields dt").textContent,
          values: [...document.querySelectorAll(".popover-fields dd")].map(rect) };
      case "headers": {
        const inner = item => {
          const bounds = rect(item);
          const style = getComputedStyle(item);
          const left = parseFloat(style.borderLeftWidth);
          return { ...bounds, x: bounds.x + left, width: bounds.width - left - parseFloat(style.borderRightWidth) };
        };
        const parts = [
          [".app-sidebar:not([data-mobile]):not([inert]):not([data-state=collapsed])", ".sidebar-top"],
          [".middle-frame", ".centre-bar"]
        ].flatMap(([pane, header]) => {
          const item = document.querySelector(pane);
          return item && item.getBoundingClientRect().width > 0 ? [[item, item.querySelector(header)]] : [];
        });
        return { rule: "headers", panes: parts.map(([pane]) => inner(pane)),
          headers: parts.map(([, header]) => ({ rect: rect(header), rule: parseFloat(getComputedStyle(header).borderBottomWidth) })) };
      }
      case "settings":
        return { rule: "settings", viewport, dialog: rect(element("[role=dialog].settings")) };
      case "drag": {
        const controls = element(".shell").dataset.windowControls;
        const overlay = navigator.windowControlsOverlay;
        const area = controls === "overlay" && overlay?.visible ? overlay.getTitlebarAreaRect() : null;
        const clear = area ? { x: area.x, y: area.y, width: area.width, height: area.height }
          : { x: 0, y: 0, width: innerWidth, height: 44 };
        const regions = [...document.querySelectorAll("*")].flatMap(item => {
          const appRegion = getComputedStyle(item).getPropertyValue("-webkit-app-region");
          const bounds = rect(item);
          return (appRegion === "drag" || appRegion === "no-drag") && bounds.width > 0 && bounds.height > 0 && bounds.y < 44
            ? [{ appRegion, rect: bounds }] : [];
        });
        const targets = [...document.querySelectorAll("button, select, input, textarea, a[href], label, summary, [role=button], [role=tab]")]
          .filter(item => getComputedStyle(item).visibility !== "hidden" && !item.closest("[inert]"))
          .flatMap(item => {
            const bounds = rect(item);
            const label = item.getAttribute("aria-label") || item.textContent.replace(/\\s+/g, " ").trim().slice(0, 40) || item.tagName.toLowerCase();
            return bounds.width > 0 && bounds.height > 0 && bounds.y < 44 ? [{ label, rect: bounds }] : [];
          });
        return { rule: "drag", services: document.querySelectorAll('ul[aria-label="Pinned"] [data-sidebar-row^="service/"]').length,
          controls, clear, viewport, centre: rect(element(".centre-bar")),
          regions, targets };
      }
      case "pin-end":
        return ${PIN_END_PROBE};
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

interface BrokenProof {
  rule: SmokeGeometry["rule"];
  selector: string;
  property: string;
  value: string;
}

const BREAKS: Partial<Record<string, BrokenProof>> = {
  "upstream-theme/1440": {
    rule: "related",
    selector: ".popover-fields dd",
    property: "width",
    value: "159px",
  },
  "strip-20/740": {
    rule: "drag",
    selector: ".centre-row > .toggle-room",
    property: "-webkit-app-region",
    value: "initial",
  },
};

async function brokenRuleProbe(
  window: BrowserWindow,
  proof: BrokenProof,
  rejects: RegExp,
): Promise<string> {
  const target = `document.querySelector(${JSON.stringify(proof.selector)})`;
  const original: string = await window.webContents.executeJavaScript(`(() => {
    const item = ${target};
    const original = item.style.getPropertyValue(${JSON.stringify(proof.property)});
    item.style.setProperty(${JSON.stringify(proof.property)}, ${JSON.stringify(proof.value)}, "important");
    return original;
  })()`);
  await rendered(window, "true");
  try {
    await measure(window, proof.rule);
    assert.fail(`Broken ${proof.rule} geometry passed`);
  } catch (error) {
    if (!(error instanceof AssertionError) || !rejects.test(error.message)) throw error;
    console.log(`Packaged broken-rule proof rejected: ${error.message}`);
    return error.message;
  } finally {
    await window.webContents.executeJavaScript(
      `${target}.style.setProperty(${JSON.stringify(proof.property)}, ${JSON.stringify(original)})`,
    );
    await rendered(window, "true");
    await measure(window, proof.rule);
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
        'document.querySelector(".centre-bar").getBoundingClientRect().height',
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
  section: (name: string) => void,
): Promise<SmokeShot[]> {
  const snapshot = withServiceLists(
    withSmokeServiceRuns(ViewSnapshotSchema.parse(JSON.parse(readFileSync(fixturePath, "utf8")))),
  );
  const recordedEnvironment = recordedChicagoSnapshot(fixturePath);
  const environmentScene = smokeEnvironment(recordedEnvironment);
  const acknowledged = ViewSnapshotSchema.parse(
    JSON.parse(readFileSync(join(dirname(fixturePath), "generated", ACKNOWLEDGED_FIXTURE), "utf8")),
  );
  const unreadForks = ViewSnapshotSchema.parse(
    JSON.parse(
      readFileSync(join(dirname(fixturePath), "generated", "snapshot-1106-unread.json"), "utf8"),
    ),
  );
  assert(
    acknowledged.sweptAt === snapshot.sweptAt && acknowledged.cursor > snapshot.cursor,
    "The acknowledged fixture must push the Nov 6 sweep again",
  );
  const mornings = loadMornings(morningPaths);
  const recorded = ViewSnapshotSchema.parse(
    JSON.parse(
      readFileSync(join(dirname(fixturePath), "generated", "snapshot-59d6895.json"), "utf8"),
    ),
  );
  const serviceSnapshot = ViewSnapshotSchema.parse(
    JSON.parse(
      readFileSync(
        join(dirname(designPath), "../apps/window/src/views/today/snapshot-1116.json"),
        "utf8",
      ),
    ),
  );
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
                "A deliberately long Related label that wraps over multiple lines in a popover",
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
  let stopDrawing: (() => Promise<void>) | undefined;
  window.webContents.debugger.attach("1.3");
  ipcMain.on("smoke:request", request);
  try {
    await window.webContents.debugger.sendCommand("Page.enable");
    stopDrawing = await keepDrawing(window);
    await window.webContents.debugger.sendCommand("Emulation.setTimezoneOverride", {
      timezoneId: SMOKE_TIME_ZONE,
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
          }
          if (surface.id === "first-sweep-running") {
            await window.webContents.executeJavaScript(`{
              localStorage.removeItem("spi-code.panes");
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
            if (surface.id === "service-calm")
              fixture(window, "view.snapshot", { ...unreadForks, cursor: scheduledCursor++ });
            if (surface.id === "environment")
              fixture(window, "view.snapshot", {
                ...environmentScene,
                cursor: scheduledCursor++,
              });
            await window.webContents.executeJavaScript(
              `location.hash = ${JSON.stringify(`#${surface.route}`)}`,
            );
            await rendered(
              window,
              `document.querySelector("[data-place]")?.textContent === ${JSON.stringify(surface.place)}`,
            );
          }
          if (surface.id.startsWith("evidence-header-")) await openSweepEvidence(window);
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
              // Template's row says its own failed reads; this one no row says stays in Failed reads.
              const denied = {
                source: "Azure/osdu-spi-legal",
                object: "pull requests",
                observedAt: snapshot.sweptAt,
                completeness: { kind: "complete" as const },
                failure: "HTTP 403 forbidden",
              };
              fixture(window, "view.snapshot", { ...snapshot, reads: [...snapshot.reads, denied] });
              await rendered(
                window,
                'document.querySelector(".today .place-reading") && !document.querySelector(".today-leaving")',
              );
              await openSweepEvidence(window);
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
              const brief = await window.webContents.executeJavaScript(BRIEF_HTML);
              fixture(window, "sweep.progress", progress.refresh);
              await rendered(
                window,
                'document.querySelector("[data-sweep-line][data-tone=run]") && document.querySelector("[data-sweep-progress]")',
              );
              assert.equal(
                await window.webContents.executeJavaScript(BRIEF_HTML),
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
          if (surface.id === "service-security") {
            await rendered(window, 'document.querySelector(".service-alert-count")');
            await window.webContents.executeJavaScript(
              'document.querySelector(".service-alert-count").click()',
            );
          }
          if (surface.id === "upstream-item") {
            await window.webContents.executeJavaScript(
              "document.querySelector(\".place-item-content[data-selection-id='campaign:toolchain:os-core-common%208.5.0']\").click()",
            );
          }
          if (surface.id === "upstream-theme") {
            await window.webContents.executeJavaScript(`{
              localStorage.setItem("spi-code.panes", JSON.stringify({
                widths: { sidebar: 232, rightPanel: 280 },
                open: { sidebar: true, rightPanel: false }
              }));
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
            await rendered(window, 'document.querySelector(".upstream .place-reading")');
            await window.webContents.executeJavaScript(
              'document.querySelector(".upstream-theme-head").click()',
            );
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
            const services = snapshot.tree.filter(({ id }) => id.startsWith("service:"));
            while (services.length < 20)
              services.push({
                id: `service:smoke-service-${services.length + 1}`,
                status: "incomplete",
              });
            await window.webContents.executeJavaScript(`{
              const key = "spi-code.sidebar.pins.v3";
              localStorage.setItem(key, ${JSON.stringify(JSON.stringify(services.map(({ id }) => id.slice(8))))});
              window.dispatchEvent(new StorageEvent("storage", { key }));
            }`);
            fixture(
              window,
              "view.snapshot",
              ViewSnapshotSchema.parse({
                ...snapshot,
                cursor: snapshot.cursor + 1,
                tree: [
                  ...snapshot.tree.filter(({ id }) => !id.startsWith("service:")),
                  ...services,
                ],
              }),
            );
          }
          if (surface.id === "sidebar-hidden")
            await window.webContents.executeJavaScript(
              'document.querySelector("#app-sidebar:not([data-mobile])[data-state=expanded]") && document.querySelector("[aria-label=\'Toggle sidebar\']").click()',
            );
          if (surface.id === "sidebar") {
            await window.webContents.executeJavaScript(
              'document.querySelector("#app-sidebar[data-mobile][data-state=collapsed]") && document.querySelector("[aria-label=\'Toggle sidebar\']").click()',
            );
            await rendered(
              window,
              'document.querySelector("#app-sidebar").getBoundingClientRect().x === 0',
            );
          }
          await rendered(window, `document.querySelector(${JSON.stringify(surface.selector)})`);
          if (surface.id === "strip" || surface.id === "strip-20")
            await rendered(
              window,
              "document.querySelector('[data-slot=sidebar-footer] [data-sweep-line]')",
            );
          if (scheduled) {
            await window.webContents.executeJavaScript(`{
              const settings = document.querySelector("[data-settings-section=sweep]");
              const panel = settings ?? document.querySelector("[data-evidence-page]");
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
              geometry.push(
                await measure(
                  window,
                  rule,
                  settings ? "[role=dialog].settings" : "[data-evidence-page]",
                  settings ? ".settings-backdrop" : "",
                ),
              );
            } else geometry.push(await measure(window, rule));
          }
          const bounds = geometry.find((check) => check.rule === "window");
          assert(bounds?.rule === "window");
          console.log(
            `Packaged window ${surface.id}/${viewportWidth}/${appearance}: viewport ${bounds.viewport.width}x${bounds.viewport.height}, page ${bounds.scroll.width}x${bounds.scroll.height}, edges 0..${Math.max(...bounds.panes.map((pane) => pane.x + pane.width))}, bottom ${Math.max(...bounds.panes.map((pane) => pane.y + pane.height))}`,
          );
          const proof = appearance === "light" && BREAKS[`${surface.id}/${viewportWidth}`];
          const rejects = BROKEN_PROOFS[`${surface.id}/${viewportWidth}`];
          const rejectedGeometry =
            proof && rejects ? await brokenRuleProbe(window, proof, rejects) : undefined;
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
                document.querySelector(".today .today-table-calm")?.textContent.trim() ?? "",
                document.querySelector('[data-sidebar-row=today] .sidebar-pip')?.textContent.trim() ?? ""
              ]`)),
              membersText(await window.webContents.executeJavaScript(DRAWN_MEMBERS)),
              lineMembersText(acknowledged.briefing.lines),
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
          if (surface.id === "environment") {
            const live = `document.querySelector(${JSON.stringify(ENVIRONMENT_LIVE)})`;
            const borrow = `document.querySelector(${JSON.stringify(ENVIRONMENT_BORROW)})`;
            await rendered(window, live);
            await window.webContents.executeJavaScript(`${live}.click()`);
            await captureSettled(
              window,
              `document.querySelector(${JSON.stringify(ENVIRONMENT_LINK)})`,
              join(output, `environment-borrow-${viewportWidth}-${appearance}.png`),
            );
            await window.webContents.executeJavaScript(
              `${borrow}.querySelector('[aria-label="Close"]').click()`,
            );
            await rendered(window, `!${borrow}`);
            for (const [mark, selector] of [
              ["hold", ENVIRONMENT_HOLD],
              ["overlap", ENVIRONMENT_OVERLAP],
            ]) {
              const anchor = `[...document.querySelectorAll(${JSON.stringify(selector)})].at(-1)`;
              const popover = 'document.querySelector(".environment .popover")';
              await rendered(window, anchor);
              await window.webContents.executeJavaScript(`${anchor}.click()`);
              await captureSettled(
                window,
                popover,
                join(output, `environment-${mark}-${viewportWidth}-${appearance}.png`),
              );
              await window.webContents.executeJavaScript(
                `${popover}.querySelector('[aria-label="Close"]').click()`,
              );
              await rendered(window, `!${popover}`);
            }
            const heading = 'document.querySelector(".environment .env-day-heading")';
            await window.webContents.executeJavaScript(
              `document.querySelector(${JSON.stringify(ENVIRONMENT_WEEK)}).click()`,
            );
            await rendered(window, heading);
            assert(
              await window.webContents.executeJavaScript(ENVIRONMENT_INSIDE_NOW),
              `Environment 7 days at ${viewportWidth}: a day heading or pill crosses the now line`,
            );
            await captureSettled(
              window,
              heading,
              join(output, `environment-7d-${viewportWidth}-${appearance}.png`),
            );
            await window.webContents.executeJavaScript(`${ENVIRONMENT_YESTERDAY}.click()`);
            await captureSettled(
              window,
              `document.activeElement === document.querySelector(${JSON.stringify(ENVIRONMENT_BACK)})`,
              join(output, `environment-day-${viewportWidth}-${appearance}.png`),
            );
            const upgrade = await window.webContents.executeJavaScript(
              environmentYesterdayUpgrade(environmentScene),
            );
            assert(
              upgrade === true,
              `Environment yesterday at ${viewportWidth}: Upgrade reads ${JSON.stringify(upgrade)}, not core's last run for that day`,
            );
            await window.webContents.executeJavaScript('location.hash = "#environment"');
            fixture(window, "view.snapshot", { ...recordedEnvironment, cursor: scheduledCursor++ });
            await captureSettled(
              window,
              `document.querySelector('.environment .env-status[data-state="idle"]') &&
              !document.querySelector(${JSON.stringify(ENVIRONMENT_BACK)})`,
              join(output, `environment-1106-${viewportWidth}-${appearance}.png`),
            );
          }
          if (surface.id === "service-calm" || surface.id === "environment")
            fixture(window, "view.snapshot", { ...snapshot, cursor: scheduledCursor++ });
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
          if (surface.id === "strip-20")
            await window.webContents.executeJavaScript(`{
              const key = "spi-code.sidebar.pins.v3";
              localStorage.removeItem(key);
              window.dispatchEvent(new StorageEvent("storage", { key }));
            }`);
          if (surface.id === "sidebar") {
            await window.webContents.executeJavaScript(
              'document.querySelector("#app-sidebar[data-mobile][data-state=expanded]") && document.querySelector(".sidebar-backdrop").click()',
            );
            await rendered(window, '!document.querySelector(".sidebar-backdrop")');
          }
          if (surface.id === "sidebar-hidden") {
            await window.webContents.executeJavaScript(
              'document.querySelector("#app-sidebar:not([data-mobile])[data-state=collapsed]") && document.querySelector("[aria-label=\'Toggle sidebar\']").click()',
            );
            await rendered(
              window,
              '!document.querySelector("#app-sidebar:not([data-mobile])[data-state=collapsed]")',
            );
          }
          if (surface.id.startsWith("evidence-header-") || surface.id === "first-sweep-evidence")
            await leaveEvidence(window);
          if (surface.id === "upstream-item" || surface.id === "upstream-theme") {
            await window.webContents.executeJavaScript(
              'document.querySelector(".popover .popover-close").click()',
            );
            await rendered(window, '!document.querySelector(".popover")');
          }
        }
        section(`captures ${viewportWidth}/${appearance}`);
        await captureTopRowPins(
          window,
          output,
          viewportWidth,
          appearance,
          () => measure(window, "pin-end"),
          (condition) => rendered(window, condition),
        );
        section(`top-row pin ${viewportWidth}/${appearance}`);
        if (viewportWidth === 1440) {
          await captureRollout(
            window,
            { ...snapshot, cursor: scheduledCursor + 50 },
            output,
            designPath,
            appearance,
            (condition) => rendered(window, condition),
            (body) => fixture(window, "view.snapshot", body),
          );
          section(`rollout rung ${appearance}`);
          await captureRepositories(
            window,
            { ...snapshot, cursor: scheduledCursor + 60 },
            output,
            designPath,
            appearance,
            (condition) => rendered(window, condition),
            (body) => fixture(window, "view.snapshot", body),
          );
          section(`repository line ${appearance}`);
          fixture(window, "sweep.progress", progress.committed);
          await captureStatusStates(
            window,
            snapshot,
            output,
            appearance,
            Date.parse(checkedAt),
            scheduledCursor + 100,
          );
          await captureSweepStates(
            window,
            snapshot,
            progress,
            output,
            appearance,
            Date.parse(checkedAt),
            scheduledCursor + 200,
          );
          await captureFindPins(window, output, appearance);
          fixture(window, "view.snapshot", { ...snapshot, cursor: scheduledCursor + 300 });
          await captureSidebarPins(window, output, appearance, (condition) =>
            rendered(window, condition),
          );
          const searchWork = serviceSnapshot.services?.find(
            ({ service }) => service === "search",
          )?.work;
          fixture(window, "view.snapshot", { ...serviceSnapshot, cursor: scheduledCursor + 301 });
          await window.webContents.executeJavaScript(
            `void (Date.now = () => ${Date.parse(serviceSnapshot.sweptAt)})`,
          );
          for (const [tab, kind, number] of [
            ["pulls", "pr", searchWork?.pulls.rows.find(({ state }) => state === "open")?.number],
            [
              "issues",
              "issue",
              searchWork?.issues.rows.find(({ state, tracks }) => state === "open" && !tracks)
                ?.number,
            ],
          ] as const) {
            assert(number, `Search fixture has a row for ${tab}`);
            await window.webContents.executeJavaScript(
              `location.hash = "#service/search/${tab}/${number}"`,
            );
            await captureSettled(
              window,
              `location.hash === "#service/search/${tab}/${number}" &&
                document.querySelector('.service-page[aria-label="search"] [data-work=${kind}] [data-row="${number}"][data-open]')`,
              join(output, `service-${tab}-${appearance}.png`),
            );
          }
          await captureSweepRulings(
            window,
            mornings.bad.snapshot,
            recorded,
            output,
            appearance,
            scheduledCursor + 302,
          );
          await window.webContents.executeJavaScript(
            `void (Date.now = () => ${Date.parse(checkedAt)})`,
          );
          section(`status, sweep, Find and sidebar captures ${viewportWidth}/${appearance}`);
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
    section("Today mornings");
    await captureForks(
      {
        window,
        output,
        rendered: (condition) => rendered(window, condition),
        fixture: (type, payload) => fixture(window, type, payload),
        setupState: ready,
      },
      serviceSnapshot,
      mornings.bad.snapshot,
    );
    section("Today Forks");
    await historyKeys(window, () => {
      fixture(window, "view.snapshot", snapshot);
      fixture(window, "setup.state", ready);
    });
    section("back and forward keys");
    assertSmokeViews(shots);
    await overlayDragProbe(window, output, async () => {
      await window.webContents.executeJavaScript(`{
        localStorage.removeItem("spi-code.panes");
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
    section("overlay drag probe");
  } finally {
    await stopDrawing?.();
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
      location.hash = "#today";
    }`);
    window.setContentSize(originalWidth, originalHeight);
    window.webContents.debugger.detach();
    const loaded = once(window.webContents, "did-finish-load");
    window.webContents.reload();
    await loaded;
  }
  writeFileSync(
    join(output, "service-design.html"),
    readFileSync(join(dirname(designPath), "spi-code-service-home.html")),
  );
  writeFileSync(
    join(output, "index.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Packaged Watch views</title>
<style>body{font-family:system-ui;margin:24px}table{width:100%;border-collapse:collapse}td,th{border:1px solid #888;padding:8px;vertical-align:top}img{width:100%}td{width:50%}</style>
<h1>Packaged Watch views</h1><p>Nov 6 projection: ${snapshot.sweptAt}. Content bounds: 1440, 900 and 740 x 800.
Appearance pinned in the app. Fixture clock: Nov 6, 09:04 America/Chicago, except scheduled
Sweep surfaces: idle and not-ready at 08:04, sweeping at 08:08, saved-with-failure at 09:04.
Setup sign-ins are intercepted fixtures, never live authentication. Related and 20-service probes vary the projection;
the 20-service probe counts the pinned service rows and holds the top row and its drag span at 740 px.
First-sweep surfaces inject schema-valid sweep.progress messages through the same smoke-only preload channel as
view.snapshot and setup.state. This screenshot phase precedes host startup, so it cannot feed the real host progress path;
the persisted-snapshot and supervision host proof runs separately, after these fixtures are removed.
Only view.snapshot hands over the first-sweep list; the refresh preserves the older brief.
Today after acknowledgement shows the Nov 6 projection in the foreground, leaves for Upstream, waits for
the window's own view.acknowledge, receives that sweep pushed again with the acknowledged baseline
(${ACKNOWLEDGED_FIXTURE}: nothing new since, its rows still drawn) and comes back to Today.
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
        const recorded =
          surface.id === "environment"
            ? `<p><a href="environment-1106-${width}-${appearance}.png">Recorded Nov 6 status</a></p>`
            : "";
        return `<td><a href="${file}"><img alt="${surface.name}, ${width} px, ${appearance}" src="${file}"></a><p>Geometry: ${shot?.geometry.map((check) => check.rule).join(", ") || "not probed on this surface"}</p>${recorded}</td>`;
      })
      .join("")}</tr></table>`,
).join("")}</section>`,
).join("\n")}
<p><a href="forks.html">Today Forks, folded, unfolded and scrolled</a></p>
<ul>${[
      ["service-pulls-retained", "Retained Pull requests"],
      ["service-doors-incomplete", "Incomplete service doors"],
      ["service-sync-halted", "Sync halted"],
      ["today-port", "Today's port row"],
      ["find-today", "Today's three groups in Find"],
    ]
      .map(
        ([file, label]) =>
          `<li>${label} ${["light", "dark"]
            .map((mode) => `<a href="${file}-${mode}.png">${mode}</a>`)
            .join(" · ")}</li>`,
      )
      .join("")}</ul>
<h1>Search service tabs</h1><p>Compare the open row in each tab with the
<a href="service-design.html">service home mock</a>.</p>
${["pulls", "issues"]
  .map(
    (tab) => `<table><tr><th colspan="2">${tab === "pulls" ? "Pull requests" : "Issues"}</th></tr>
<tr><th>Light</th><th>Dark</th></tr><tr>${["light", "dark"]
      .map((mode) => {
        const file = `service-${tab}-${mode}.png`;
        return `<td><a href="${file}"><img alt="${tab} in ${mode}" src="${file}"></a></td>`;
      })
      .join("")}</tr></table>`,
  )
  .join("")}
<h1>Today on three mornings</h1><p>Each morning is a schema-valid snapshot shown through the same smoke-only
preload channel, at the Nov 6 fixture clock: ${MORNING_SURFACES.filter(
      ({ open, view }) => !open && view === "yours",
    )
      .map(({ morning }) => `${morning} from ${mornings[morning].fixture}`)
      .join(", ")}.
Each image is the whole Today frame: the window is 800 px tall, and Today's pane is captured strip by
strip as it scrolls and joined, so sections below the fold are in the image. Beside the pane, the sidebar
continues its last row below the window's height. The blocks line under each image is the DOM evidence:
each block's top and height in the image, in CSS pixels. Yours is the tab Today opens on; Row opened
clicks the first Blocked or Waiting on you headline, which opens in place under the row. Sync PR pressed
loads #today/yours/sync and Activity loads #today/activity on the busy morning.
Design: spi-code-service-home.md (Today and rulings D5, D6) wins over draft 9's Today in its mock.
Record match or mismatch per surface against the rulings named under it.</p>
${MORNING_SURFACES.map(
  (
    surface,
  ) => `<section><h2>Today, ${surface.morning} morning, ${{ yours: "Yours", sync: "Yours with Sync PR pressed", activity: "Activity" }[surface.view]}${surface.open ? ", row opened" : ""}</h2>
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
    return `<h3>${width} px</h3><p>spi-code-service-home.md: ${evidence?.sections.join("; ") ?? ""}</p>
<p>Headline: ${escapeHtml(evidence?.headline ?? "")}${row[0]?.qualifiers[1] ? `<br>Caveat band: ${escapeHtml(row[0].qualifiers[1])}` : ""}${evidence?.opened ? `<br>Opened: ${escapeHtml(evidence.opened)}` : ""}</p>
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
