// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Message, PROTOCOL_VERSION, parseMessage } from "@spi-code/contracts";
import { expect, it, vi } from "vitest";
import { attachHostPort, type HostPort, type HostRequestQueue } from "./port.js";

it("validates both directions and never dispatches malformed ping messages", () => {
  const sent: unknown[] = [];
  let receive: (event: { data: unknown }) => void = () => {
    throw new Error("Port not attached");
  };
  const port: HostPort = {
    on(_event, listener) {
      receive = listener;
    },
    postMessage(message) {
      sent.push(message);
    },
    start() {},
  };
  attachHostPort(port, 123);
  receive({
    data: { version: PROTOCOL_VERSION, id: "ping", kind: "request", type: "ping", payload: {} },
  });
  receive({
    data: {
      version: PROTOCOL_VERSION,
      id: "bad",
      kind: "request",
      type: "ping",
      payload: { extra: true },
    },
  });
  receive({ data: null });
  receive({
    data: {
      version: PROTOCOL_VERSION,
      id: "wrong-way",
      kind: "response",
      type: "pong",
      payload: {},
    },
  });
  expect(sent.map((message) => parseMessage(message).ok)).toEqual([true, true, true, true]);
  expect(sent).toMatchObject([
    { type: "host.hello", payload: { pid: 123 } },
    { type: "pong", id: "ping" },
    { type: "error", payload: { code: "invalid_message" } },
    { type: "error", payload: { code: "invalid_message" } },
  ]);
});

it("ignores inbound responses and events without replying or dispatching", () => {
  const sent: unknown[] = [];
  let receive: (event: { data: unknown }) => void = () => {};
  const handler = vi.fn();
  attachHostPort(
    {
      on(_event, listener) {
        receive = listener;
      },
      postMessage(message) {
        sent.push(message);
      },
      start() {},
    },
    123,
    handler,
  );
  sent.length = 0;
  for (const message of [
    { kind: "response", type: "error", payload: { code: "invalid_message", message: "Rejected" } },
    { kind: "response", type: "pong", payload: {} },
    { kind: "event", type: "host.hello", payload: { pid: 456 } },
  ]) {
    receive({ data: { version: PROTOCOL_VERSION, id: "wrong-way", ...message } });
  }
  expect(sent).toEqual([]);
  expect(handler).not.toHaveBeenCalled();
});

it("serializes turns and refreshes, rejects malformed dispatch, and recovers from a failed request", async () => {
  const sent: unknown[] = [];
  let receive: (event: { data: unknown }) => void = () => {};
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const handler = vi.fn(async (message: Message) => {
    if (message.id === "first") {
      await blocked;
      throw new Error("private credential");
    }
    finish();
  });
  attachHostPort(
    {
      on(_event, listener) {
        receive = listener;
      },
      postMessage(message) {
        sent.push(message);
      },
      start() {},
    },
    123,
    handler,
  );
  const request = { version: PROTOCOL_VERSION, kind: "request", type: "models.list", payload: {} };
  receive({ data: { ...request, id: "malformed", payload: { token: "secret" } } });
  receive({ data: { ...request, id: "first" } });
  receive({ data: { ...request, id: "second" } });
  await Promise.resolve();
  expect(handler.mock.calls.map(([message]) => message.id)).toEqual(["first"]);
  release();
  await done;
  expect(handler.mock.calls.map(([message]) => message.id)).toEqual(["first", "second"]);
  expect(sent).toMatchObject([
    { type: "host.hello" },
    { type: "error", payload: { code: "invalid_message" } },
    { type: "error", payload: { code: "host_failed" } },
  ]);
  expect(JSON.stringify(sent)).not.toContain("private credential");
});

it("logs a failed error reply and lets the next queued request run", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    let receive: (event: { data: unknown }) => void = () => {};
    const queue: HostRequestQueue = { pending: Promise.resolve() };
    const handler = vi.fn(async (message: Message) => {
      if (message.id === "first") throw new Error("private credential");
    });
    attachHostPort(
      {
        on(_event, listener) {
          receive = listener;
        },
        postMessage(message) {
          const parsed = parseMessage(message);
          if (parsed.ok && parsed.message.type === "error")
            throw new Error("private transport detail");
        },
        start() {},
      },
      123,
      handler,
      queue,
    );
    const request = {
      version: PROTOCOL_VERSION,
      kind: "request",
      type: "models.list",
      payload: {},
    };
    receive({ data: { ...request, id: "first" } });
    await expect(queue.pending).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledExactlyOnceWith("Host request failure response could not be sent");
    receive({ data: { ...request, id: "second" } });
    await queue.pending;
    expect(handler.mock.calls.map(([message]) => message.id)).toEqual(["first", "second"]);
  } finally {
    log.mockRestore();
  }
});
