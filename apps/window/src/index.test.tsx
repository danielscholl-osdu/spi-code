// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Message, PROTOCOL_VERSION } from "@spi-code/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { expect, it, vi } from "vitest";
import mixed from "../../../fixtures/watch/snapshot-mixed-59d6895.json?raw";
import type { Route } from "./app/routes.js";
import { mixedSnapshot } from "./store/test-snapshot.js";

vi.mock("react-dom/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-dom/client")>();
  return { ...original, createRoot: vi.fn(original.createRoot) };
});

async function mountWindow(proof: boolean) {
  vi.resetModules();
  const previous = window.spi;
  const listeners = new Set<(input: unknown) => void>();
  const postMessage = vi.fn<(message: Message) => void>();
  const forwardToMain = vi.fn<(input: unknown) => void>();
  window.location.hash = "";
  window.spi = {
    proof,
    openExternal: vi.fn(),
    postMessage,
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  let root: Root | undefined;
  await act(async () => {
    await import("./index.js");
    root = vi.mocked(createRoot).mock.results.at(-1)?.value;
  });
  return {
    container,
    postMessage,
    forwardToMain,
    receive: (message: unknown) =>
      act(async () => {
        for (const listener of listeners) listener(message);
        if (proof) forwardToMain(message);
      }),
    async cleanup() {
      await act(async () => root?.unmount());
      container.remove();
      window.spi = previous;
      expect(listeners.size).toBe(0);
    },
  };
}

const hello = (pid = 123): Message => ({
  version: PROTOCOL_VERSION,
  id: "hello",
  kind: "event",
  type: "host.hello",
  payload: { pid },
});

const models = (catalog: { id: string; name: string }[]): Message => ({
  version: PROTOCOL_VERSION,
  id: "catalog",
  kind: "response",
  type: "models.result",
  payload: { models: catalog },
});

it.each([
  {
    version: PROTOCOL_VERSION,
    id: "invalid-hello",
    kind: "event",
    type: "host.hello",
    payload: { pid: "invalid" },
  },
  {
    version: PROTOCOL_VERSION,
    id: "unexpected-request",
    kind: "request",
    type: "models.list",
    payload: {},
  },
])("rejects $id without throwing or blocking preload's proof forwarding", async (message) => {
  const app = await mountWindow(true);
  try {
    await expect(app.receive(message)).resolves.toBeUndefined();
    expect(app.forwardToMain).toHaveBeenCalledExactlyOnceWith(message);
    expect(app.postMessage.mock.calls.some(([sent]) => sent.type === "turn.start")).toBe(false);
  } finally {
    await app.cleanup();
  }
});

function expectNoTurnUI(container: HTMLElement) {
  expect(
    container.querySelector(
      'textarea, [contenteditable="true"], .turn-panel, [data-slot="composer"], [aria-label="Copilot response"], [aria-label="Tool events"]',
    ),
  ).toBeNull();
  expect(
    [...container.querySelectorAll("summary")].some(
      (summary) => summary.textContent === "Copilot turn",
    ),
  ).toBe(false);
  expect(container.querySelector('label[for="prompt"], label[for="model"]')).toBeNull();
}

it.each([false, true])(
  "renders no composer or turn panel on every shell route (proof=%s)",
  async (proof) => {
    const app = await mountWindow(proof);
    try {
      const { DEFAULT_REGISTRY, isReachable, routeHash, routeLabel } = await import(
        "./app/routes.js"
      );
      const snapshot = mixedSnapshot(mixed);
      await app.receive({
        version: PROTOCOL_VERSION,
        id: "snapshot",
        kind: "event",
        type: "view.snapshot",
        payload: snapshot,
      });
      const routes: Record<Route["kind"], Route[]> = {
        today: [{ kind: "today" }],
        upstream: [{ kind: "upstream" }],
        environment: [{ kind: "environment" }],
        "engineering-system": [{ kind: "engineering-system" }],
        releases: [{ kind: "releases" }],
        security: [{ kind: "security" }],
        service: snapshot.stations.map(({ service }) => ({ kind: "service", id: service })),
        release: snapshot.releases.lines.map(({ month }) => ({ kind: "release", month })),
      };
      const reachable = Object.values(routes)
        .flat()
        .filter((route) => isReachable(route, DEFAULT_REGISTRY));
      for (const route of reachable) {
        await act(async () => {
          window.location.hash = routeHash(route);
          window.dispatchEvent(new HashChangeEvent("hashchange"));
        });
        expect(document.title).toBe(`SPI Code · ${routeLabel(route)}`);
        expectNoTurnUI(app.container);
      }
      if (!proof) {
        await app.receive(hello());
        await app.receive(models([{ id: "model", name: "Model" }]));
        expect(app.postMessage.mock.calls.some(([message]) => message.type === "turn.start")).toBe(
          false,
        );
      }
    } finally {
      await app.cleanup();
    }
  },
);

it("keeps the packaged proof harness starting one turn without rendering turn UI", async () => {
  const app = await mountWindow(true);
  try {
    await app.receive(hello());
    const sent = () => app.postMessage.mock.calls.map(([message]) => message);
    expect(sent()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "window-ping", type: "ping" }),
        expect.objectContaining({ id: "catalog", type: "models.list" }),
      ]),
    );
    await app.receive(models([]));
    expect(sent().filter(({ type }) => type === "turn.start")).toHaveLength(0);
    await app.receive(models([{ id: "stub-model", name: "Fixture model" }]));
    const turns = sent().filter(({ type }) => type === "turn.start");
    expect(turns).toEqual([
      expect.objectContaining({
        version: PROTOCOL_VERSION,
        id: expect.any(String),
        kind: "request",
        type: "turn.start",
        payload: {
          modelId: "stub-model",
          prompt: "Call spi_brief with empty arguments, then reply with one short sentence.",
        },
      }),
    ]);
    await app.receive(hello(456));
    await app.receive(models([{ id: "stub-model", name: "Fixture model" }]));
    expect(sent().filter(({ type }) => type === "turn.start")).toEqual(turns);
    expectNoTurnUI(app.container);
  } finally {
    await app.cleanup();
  }
});
