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
    {
      "models.list": Object.assign(handler, { serial: true }),
      "turn.start": Object.assign(handler, { serial: true }),
    },
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
    {
      "models.list": Object.assign(handler, { serial: true }),
      "turn.start": Object.assign(handler, { serial: true }),
    },
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
      {
        "models.list": Object.assign(handler, { serial: true }),
        "turn.start": Object.assign(handler, { serial: true }),
      },
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

it("queues arbitrary serial routes together while a plain route answers", async () => {
  const sent: unknown[] = [];
  let receive: (event: { data: unknown }) => void = () => {};
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const order: string[] = [];
  const queue: HostRequestQueue = { pending: Promise.resolve() };
  const answer = (message: Message, send: (message: Message) => void) => {
    order.push(message.id);
    send({
      version: PROTOCOL_VERSION,
      id: message.id,
      kind: "response",
      type: "pong",
      payload: {},
    });
  };
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
    1,
    {
      "view.subscribe": Object.assign(
        async (message: Message, send: (message: Message) => void) => {
          order.push("started");
          await blocked;
          answer(message, send);
        },
        { serial: true },
      ),
      "setup.check": Object.assign(answer, { serial: true }),
      "models.list": (message, send) => answer(message, send),
    },
    queue,
  );
  for (const [id, type] of [
    ["first", "view.subscribe"],
    ["second", "setup.check"],
    ["plain", "models.list"],
  ])
    receive({
      data: {
        version: PROTOCOL_VERSION,
        id,
        kind: "request",
        type,
        payload: type === "view.subscribe" ? { fromCursor: 0 } : {},
      },
    });
  try {
    await vi.waitFor(() => expect(order).toEqual(["started", "plain"]));
    expect(sent).toContainEqual(expect.objectContaining({ id: "plain", type: "pong" }));
    expect(sent).not.toContainEqual(expect.objectContaining({ id: "second" }));
  } finally {
    release();
  }
  await queue.pending;
  expect(order).toEqual(["started", "plain", "first", "second"]);
});

it("fails closed for unregistered routes, throwing routes and invalid outbound messages", async () => {
  const sent: unknown[] = [];
  let receive: (event: { data: unknown }) => void = () => {};
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
    1,
    {
      "setup.check": () => {
        throw new Error("private failure");
      },
      "models.list": (_message, send) =>
        send({
          version: PROTOCOL_VERSION,
          id: "bad",
          kind: "response",
          type: "pong",
          payload: { extra: true },
        } as unknown as Message),
    },
  );
  for (const type of ["view.subscribe", "setup.check", "models.list"])
    receive({
      data: {
        version: PROTOCOL_VERSION,
        id: type,
        kind: "request",
        type,
        payload: type === "view.subscribe" ? { fromCursor: 0 } : {},
      },
    });
  await vi.waitFor(() => expect(sent).toHaveLength(4));
  expect(sent.slice(1)).toMatchObject([
    { id: "view.subscribe", type: "error", payload: { code: "unsupported_message" } },
    { id: "setup.check", type: "error", payload: { code: "host_failed" } },
    { id: "models.list", type: "error", payload: { code: "host_failed" } },
  ]);
  expect(sent.every((message) => parseMessage(message).ok)).toBe(true);
  expect(JSON.stringify(sent)).not.toContain("private failure");
});

it("rejects requests queued before stop and received after stop", async () => {
  const sent: unknown[] = [];
  let receive: (event: { data: unknown }) => void = () => {};
  const queue: HostRequestQueue = { pending: Promise.resolve() };
  const handler = vi.fn();
  const stop = attachHostPort(
    {
      on(_event, listener) {
        receive = listener;
      },
      postMessage(message) {
        sent.push(message);
      },
      start() {},
    },
    1,
    { "models.list": Object.assign(handler, { serial: true }) },
    queue,
  );
  const request = { version: PROTOCOL_VERSION, kind: "request", type: "models.list", payload: {} };
  receive({ data: { ...request, id: "queued" } });
  stop();
  receive({ data: { ...request, id: "stopped" } });
  await queue.pending;
  expect(handler).not.toHaveBeenCalled();
  expect(sent.slice(1)).toMatchObject([
    { id: "stopped", type: "error", payload: { code: "host_failed" } },
    { id: "queued", type: "error", payload: { code: "host_failed" } },
  ]);
});
