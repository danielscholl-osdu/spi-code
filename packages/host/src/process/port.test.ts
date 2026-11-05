// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { parseMessage } from "@spi-code/contracts";
import { expect, it } from "vitest";
import { attachHostPort, type HostPort } from "./port.js";

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
  receive({ data: { version: 1, id: "ping", kind: "request", type: "ping", payload: {} } });
  receive({
    data: { version: 1, id: "bad", kind: "request", type: "ping", payload: { extra: true } },
  });
  receive({ data: null });
  receive({ data: { version: 1, id: "wrong-way", kind: "response", type: "pong", payload: {} } });
  expect(sent.map((message) => parseMessage(message).ok)).toEqual([true, true, true, true, true]);
  expect(sent).toMatchObject([
    { type: "host.hello", payload: { pid: 123 } },
    { type: "pong", id: "ping" },
    { type: "error", payload: { code: "invalid_message" } },
    { type: "error", payload: { code: "invalid_message" } },
    { type: "error", payload: { code: "unsupported_message" } },
  ]);
});
