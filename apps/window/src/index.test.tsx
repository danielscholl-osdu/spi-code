// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Message, PROTOCOL_VERSION } from "@spi-code/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-dom/client")>();
  return { ...original, createRoot: vi.fn(original.createRoot) };
});

it.each(["restart", "give-up"] as const)(
  "unblocks the turn controls and displays a turn error after host %s",
  async (kind) => {
    vi.resetModules();
    const previous = window.spi;
    const listeners = new Set<(input: unknown) => void>();
    const postMessage = vi.fn<(message: Message) => void>();
    window.spi = {
      proof: true,
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
    const receive = (message: Message) =>
      act(async () => {
        for (const listener of listeners) listener(message);
      });
    const hello = (pid: number): Message => ({
      version: PROTOCOL_VERSION,
      id: "hello",
      kind: "event",
      type: "host.hello",
      payload: { pid },
    });
    try {
      await act(async () => {
        await import("./index.js");
      });
      root = vi.mocked(createRoot).mock.results.at(-1)?.value;
      await receive(hello(123));
      await receive({
        version: PROTOCOL_VERSION,
        id: "catalog",
        kind: "response",
        type: "models.result",
        payload: { models: [{ id: "model", name: "Model" }] },
      });
      const turn = postMessage.mock.calls
        .map(([message]) => message)
        .find(({ type }) => type === "turn.start");
      expect(turn).toBeDefined();
      const prompt = container.querySelector("textarea");
      expect(prompt?.disabled).toBe(true);
      await receive(hello(123));
      expect(prompt?.disabled).toBe(true);
      await receive(
        kind === "restart"
          ? hello(456)
          : {
              version: PROTOCOL_VERSION,
              id: "unrelated-supervisor-request",
              kind: "response",
              type: "error",
              payload: {
                code: "host_unavailable",
                message: "Host stopped after repeated crashes.",
              },
            },
      );
      expect(prompt?.disabled).toBe(false);
      const panel = container.querySelector(".turn-panel");
      expect(panel?.textContent).toContain(
        kind === "restart" ? "Turn failed: host restarted." : "Turn failed: host unavailable.",
      );
      expect(panel?.querySelector('button[type="submit"]')?.textContent).toBe("Send");
      if (!turn) throw new Error("Proof did not start a turn");
      await receive({
        version: PROTOCOL_VERSION,
        id: turn.id,
        kind: "event",
        type: "turn.delta",
        payload: { text: "Stale output" },
      });
      expect(panel?.textContent).not.toContain("Stale output");
    } finally {
      await act(async () => root?.unmount());
      container.remove();
      window.spi = previous;
    }
  },
);
