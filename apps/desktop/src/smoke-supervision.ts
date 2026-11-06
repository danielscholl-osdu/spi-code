// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { BrowserWindow, MessageChannelMain, UtilityProcess } from "electron";
import { assertNoProcessListeners } from "./smoke-listeners.js";
import type { smokeMessages } from "./smoke-messages.js";
import {
  initialHeadline,
  resumedHeadline,
  smokeSnapshotCursors,
  writeSmokeSnapshot,
} from "./smoke-snapshot.js";

export function smokeClock(argv: readonly string[]) {
  if (!argv.includes("--smoke")) return undefined;
  let accelerated = false;
  return {
    accelerate() {
      accelerated = true;
    },
    schedule(delay: number, callback: () => void) {
      const timer = setTimeout(callback, accelerated && delay < 60000 ? 5 : delay);
      return () => clearTimeout(timer);
    },
  };
}

export interface SupervisionReport {
  signal: "SIGKILL";
  hostPids: number[];
  channelTransfers: number;
  fromCursor: number;
  resumedCursor: number;
  persistedCursors: number[];
  sameRenderer: true;
  freshChannel: true;
  giveUpAcrossReload: true;
  reloadExactlyOnce: true;
  lateSubframeNoReconnect: true;
  canceledNavigationNoReconnect: true;
}

async function displayed(window: BrowserWindow, text: string): Promise<void> {
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const matches = () => document.querySelector("main")?.innerText.includes(${JSON.stringify(text)});
    if (matches()) return resolve();
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error("Timed out waiting for rendered smoke evidence"));
    }, 10000);
    const observer = new MutationObserver(() => {
      if (!matches()) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  })`);
}

export async function exerciseSupervision(options: {
  window: BrowserWindow;
  messages: ReturnType<typeof smokeMessages>;
  currentHost(): UtilityProcess;
  channels: MessageChannelMain[];
  storePath: string;
  firstCursor: number;
  clock: NonNullable<ReturnType<typeof smokeClock>>;
  listeners: string[];
}): Promise<SupervisionReport> {
  const { window, messages, channels, storePath, firstCursor, clock } = options;
  await displayed(window, initialHeadline);
  assert.equal(
    channels.length,
    2,
    "Initial connection and main-frame reload must transfer once each",
  );
  const frameLoaded = once(window.webContents, "did-frame-finish-load");
  const frameStopped = once(window.webContents, "did-stop-loading");
  await window.webContents.executeJavaScript(`{
    const frame = document.createElement("iframe");
    frame.id = "spi-smoke-late-frame";
    frame.hidden = true;
    frame.srcdoc = "<!doctype html><title>Late smoke frame</title>";
    void document.body.appendChild(frame);
  }`);
  const [, isMainFrame] = await frameLoaded;
  assert.equal(isMainFrame, false, "Late iframe must finish a real subframe load");
  await frameStopped;
  assert.equal(channels.length, 2, "Late subframe must not transfer another host channel");
  await window.webContents.executeJavaScript(
    'document.getElementById("spi-smoke-late-frame").remove()',
  );
  const kept = randomUUID();
  await window.webContents.executeJavaScript(
    `document.documentElement.dataset.smokeKept = ${JSON.stringify(kept)}`,
  );
  const blocked = once(window.webContents, "will-navigate");
  const blockedStopped = once(window.webContents, "did-stop-loading");
  await window.webContents.executeJavaScript('location.href = "spi-smoke-blocked.html"');
  await Promise.all([blocked, blockedStopped]);
  const canceledStopped = once(window.webContents, "did-stop-loading");
  window.webContents.reload();
  window.webContents.stop();
  await canceledStopped;
  assert.equal(
    await window.webContents.executeJavaScript("document.documentElement.dataset.smokeKept"),
    kept,
    "Canceled main-frame navigations must keep the current document",
  );
  assert.equal(
    channels.length,
    2,
    "Canceled main-frame navigations must not transfer another host channel",
  );
  const token = randomUUID();
  await window.webContents.executeJavaScript(
    `document.documentElement.dataset.smokeDocument = ${JSON.stringify(token)}`,
  );
  const rendererPid = window.webContents.getOSProcessId();
  const contentsId = window.webContents.id;
  let loads = 0;
  const loaded = () => loads++;
  window.webContents.on("did-finish-load", loaded);
  const previous = channels.at(-1);
  assert(previous);
  const transfersBefore = channels.length;
  const hostPids: number[] = [];
  const kill = async () => {
    const host = options.currentHost();
    assert(host.pid);
    hostPids.push(host.pid);
    const exited = once(host, "exit");
    process.kill(host.pid, "SIGKILL");
    await exited;
  };
  try {
    messages.clear();
    const resumedCursor = writeSmokeSnapshot(storePath, resumedHeadline);
    await kill();
    const hello = await messages.wait("hello");
    assert(hello.type === "host.hello");
    assert.equal(hello.payload.pid, options.currentHost().pid);
    assert.notEqual(hello.payload.pid, hostPids[0]);
    const subscribe = await messages.wait((message) => message.type === "view.subscribe");
    assert(subscribe.type === "view.subscribe");
    assert.equal(subscribe.payload.fromCursor, firstCursor);
    const snapshot = await messages.wait((message) => message.type === "view.snapshot");
    assert(snapshot.type === "view.snapshot");
    assert.equal(snapshot.payload.cursor, resumedCursor);
    assert.equal(snapshot.payload.briefing.headline, resumedHeadline);
    await displayed(window, resumedHeadline);
    assert.equal(window.webContents.id, contentsId);
    assert.equal(window.webContents.getOSProcessId(), rendererPid);
    assert.equal(
      await window.webContents.executeJavaScript("document.documentElement.dataset.smokeDocument"),
      token,
    );
    assert.equal(loads, 0, "Recovery reloaded the renderer");
    assert.equal(channels.length, transfersBefore + 1);
    const fresh = channels.at(-1);
    assert(fresh);
    assert.notEqual(fresh.port1, previous.port1);
    assert.notEqual(fresh.port2, previous.port2);
    assert.equal((await messages.wait("window-ping")).type, "pong");
    options.listeners.push(...assertNoProcessListeners(process.pid, hello.payload.pid).listeners);
    const persistedCursors = smokeSnapshotCursors(storePath);
    assert.deepEqual(persistedCursors, [firstCursor, resumedCursor]);

    // Keep the real first backoff; bound the remaining crash-budget exercise.
    clock.accelerate();
    for (let attempt = 1; attempt < 8; attempt++) {
      messages.clear();
      await kill();
      if (attempt < 7) {
        const next = await messages.wait("hello");
        assert(next.type === "host.hello");
        assert.equal(next.payload.pid, options.currentHost().pid);
      }
    }
    const giveUp = await messages.wait(
      (message) => message.type === "error" && message.payload.code === "host_unavailable",
    );
    assert(giveUp.type === "error");
    await displayed(window, giveUp.payload.message);
    messages.clear();
    const transfersBeforeReload = channels.length;
    const reloaded = once(window.webContents, "did-finish-load");
    window.webContents.reload();
    await reloaded;
    const replayed = await messages.wait(
      (message) => message.type === "error" && message.payload.code === "host_unavailable",
    );
    assert.deepEqual(replayed, giveUp);
    await displayed(window, giveUp.payload.message);
    assert.equal(channels.length, transfersBeforeReload + 1);
    assert.equal(loads, 1);
    assert.equal(new Set(hostPids).size, 8);
    return {
      signal: "SIGKILL",
      hostPids,
      channelTransfers: channels.length - transfersBefore,
      fromCursor: firstCursor,
      resumedCursor,
      persistedCursors,
      sameRenderer: true,
      freshChannel: true,
      giveUpAcrossReload: true,
      reloadExactlyOnce: true,
      lateSubframeNoReconnect: true,
      canceledNavigationNoReconnect: true,
    };
  } finally {
    window.webContents.off("did-finish-load", loaded);
  }
}
