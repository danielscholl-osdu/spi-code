// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { type Message, PROTOCOL_VERSION } from "@spi-code/contracts";
import { expect, it, vi } from "vitest";
import { smokeMessages } from "./smoke-messages.js";

const reply: Message = {
  version: PROTOCOL_VERSION,
  id: "window-ping",
  kind: "response",
  type: "error",
  payload: { code: "unsupported_message", message: "Probe failed" },
};

it("returns a correlated failure instead of waiting only for a successful pong", async () => {
  const inbox = smokeMessages();
  inbox.push(reply);
  const observed = await inbox.wait("window-ping");
  expect(observed).toEqual(reply);
  expect(observed.type === "pong").toBe(false);
});

it("ignores other ids and observes the matching message arriving later", async () => {
  const inbox = smokeMessages();
  const observed = inbox.wait("window-ping");
  inbox.push({ ...reply, id: "other" });
  inbox.push(reply);
  expect(await observed).toEqual(reply);
  expect(await inbox.wait("other")).toMatchObject({ id: "other" });
});

it("waits for the requested turn instead of consuming an earlier turn end", async () => {
  const inbox = smokeMessages();
  const end: Message = {
    version: PROTOCOL_VERSION,
    id: "old",
    kind: "event",
    type: "turn.end",
    payload: { reason: "completed" },
  };
  inbox.push(end);
  const observed = inbox.waitForTurn("current");
  inbox.push({ ...reply, id: "current" });
  expect(await observed).toEqual({ ...reply, id: "current" });
  expect(await inbox.wait("old")).toEqual(end);
  const next = inbox.waitForTurn("next");
  inbox.push({ ...end, id: "unrelated" });
  inbox.push({ ...end, id: "next" });
  expect(await next).toEqual({ ...end, id: "next" });
});

it("observes the outbound start before a turn can fail without streaming text", async () => {
  const inbox = smokeMessages();
  const start: Message = {
    version: PROTOCOL_VERSION,
    id: "early-failure",
    kind: "request",
    type: "turn.start",
    payload: { modelId: "stub", prompt: "Probe" },
  };
  let bridge: { postMessage(message: Message): void } | undefined;
  let connect: ((event: { ports: unknown[] }) => void) | undefined;
  const terminal = { ...reply, id: start.id };
  runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
    require: () => ({
      contextBridge: {
        exposeInMainWorld: (_name: string, value: typeof bridge) => {
          bridge = value;
        },
      },
      ipcRenderer: {
        on: (name: string, listener: typeof connect) => {
          if (name === "host:port") connect = listener;
        },
        send: (name: string, message: Message) => {
          expect(name).toBe("proof:message");
          inbox.push(message);
        },
      },
    }),
    process: { argv: ["--spi-proof"] },
  });
  if (!bridge || !connect) throw new Error("Missing preload bridge");
  const port = {
    start() {},
    postMessage: (message: Message) => {
      expect(message).toEqual(start);
      inbox.push(terminal);
    },
  };
  connect({ ports: [port] });
  const observed = inbox.waitForStartedTurn();
  const failure = expect(observed).rejects.toThrow("Probe failed");
  bridge.postMessage(start);
  await failure;
});

it("correlates each started turn across reloads without consuming another turn's end", async () => {
  const inbox = smokeMessages();
  const start: Message = {
    version: PROTOCOL_VERSION,
    id: "first",
    kind: "request",
    type: "turn.start",
    payload: { modelId: "stub", prompt: "Probe" },
  };
  const end: Message = {
    version: PROTOCOL_VERSION,
    id: "unrelated",
    kind: "event",
    type: "turn.end",
    payload: { reason: "completed" },
  };
  for (const id of ["first", "reloaded"]) {
    const pending = inbox.waitForStartedTurn();
    inbox.push(end);
    inbox.push({ ...start, id });
    inbox.push({ ...end, id });
    expect(await pending).toEqual({ ...end, id });
    expect(await inbox.wait(end.id)).toEqual(end);
    inbox.clear();
  }
});

it("times out without an observation and can still wait for a later message", async () => {
  vi.useFakeTimers();
  try {
    const inbox = smokeMessages();
    const timeout = expect(inbox.wait("missing")).rejects.toThrow(
      "Timed out waiting for a host message",
    );
    await vi.advanceTimersByTimeAsync(10000);
    await timeout;
    inbox.push(reply);
    expect(await inbox.wait("window-ping")).toEqual(reply);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
