// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { type Message, parseMessage } from "./index.js";

const envelope = { version: 1, id: "request-1" } as const;
const messages = [
  { ...envelope, kind: "event", type: "host.hello", payload: { pid: 123 } },
  { ...envelope, kind: "request", type: "ping", payload: {} },
  { ...envelope, kind: "response", type: "pong", payload: {} },
  { ...envelope, kind: "request", type: "models.list", payload: {} },
  {
    ...envelope,
    kind: "response",
    type: "models.result",
    payload: { models: [{ id: "model-1", name: "Model One" }] },
  },
  {
    ...envelope,
    kind: "request",
    type: "turn.start",
    payload: { modelId: "model-1", prompt: "Hello" },
  },
  { ...envelope, kind: "event", type: "turn.delta", payload: { text: "Hello back" } },
  { ...envelope, kind: "event", type: "turn.end", payload: { reason: "completed" } },
  {
    ...envelope,
    kind: "event",
    type: "tool.call",
    payload: { callId: "call-1", name: "spi_brief", arguments: { fresh: true } },
  },
  {
    ...envelope,
    kind: "response",
    type: "error",
    payload: { code: "TURN_FAILED", message: "The turn failed" },
  },
] satisfies Message[];

describe("M0 message contract", () => {
  it.each(messages)("round-trips $type", (message) => {
    expect(parseMessage(JSON.parse(JSON.stringify(message)))).toEqual({
      ok: true,
      message,
    });
  });

  it.each([
    null,
    [],
    {},
    { ...messages[0], version: 2 },
    { ...messages[0], id: "" },
    { ...messages[0], kind: "request" },
    { ...messages[0], unexpected: true },
    { ...messages[0], type: "unknown.message" },
    { ...messages[0], payload: { pid: "123" } },
    { ...messages[0], payload: { pid: 1.5 } },
    { ...messages[0], payload: { pid: 0 } },
  ])("rejects malformed input with a structured reason: %j", (input) => {
    const result = parseMessage(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.reason).toBe("invalid_message");
      expect(result.rejection.issues.length).toBeGreaterThan(0);
      expect(result.rejection.issues[0]).toEqual({
        code: expect.any(String),
        path: expect.any(Array),
        message: expect.any(String),
      });
    }
  });

  it.each(messages)("rejects extra payload fields in $type", (message) => {
    expect(
      parseMessage({
        ...message,
        payload: { ...message.payload, unexpected: true },
      }).ok,
    ).toBe(false);
  });

  it.each(messages)("rejects missing payload fields in $type", (message) => {
    expect(parseMessage({ ...message, payload: null }).ok).toBe(false);
    for (const field of Object.keys(message.payload)) {
      const payload = { ...message.payload };
      Reflect.deleteProperty(payload, field);
      expect(parseMessage({ ...message, payload }).ok).toBe(false);
    }
  });

  it("rejects invalid nested model fields and non-JSON tool arguments", () => {
    expect(
      parseMessage({
        ...messages[4],
        payload: { models: [{ id: "model-1", name: 123 }] },
      }).ok,
    ).toBe(false);
    expect(
      parseMessage({
        ...messages[4],
        payload: { models: [{ id: "model-1", name: "One", secret: true }] },
      }).ok,
    ).toBe(false);
    expect(
      parseMessage({
        ...messages[8],
        payload: { callId: "call-1", name: "spi_brief", arguments: { fn() {} } },
      }).ok,
    ).toBe(false);
  });
});
