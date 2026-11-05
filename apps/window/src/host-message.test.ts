// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION } from "@spi-code/contracts";
import { expect, it, vi } from "vitest";
import { hostMessageHandler } from "./host-message.js";

it("rejects malformed host messages and wrong-way requests without dispatching or replying", () => {
  const accept = vi.fn();
  const reject = vi.fn();
  const receive = hostMessageHandler(accept, reject, () => undefined);
  receive(null);
  receive({
    version: PROTOCOL_VERSION,
    id: "bad",
    kind: "event",
    type: "host.hello",
    payload: { pid: -1 },
  });
  receive({ version: PROTOCOL_VERSION, id: "request", kind: "request", type: "ping", payload: {} });
  expect(accept).not.toHaveBeenCalled();
  expect(reject).toHaveBeenCalledTimes(3);
  const hello = {
    version: PROTOCOL_VERSION,
    id: "hello",
    kind: "event",
    type: "host.hello",
    payload: { pid: 123 },
  };
  receive(hello);
  expect(accept).toHaveBeenCalledExactlyOnceWith(hello);
});

it("ignores stale turn output after reload and while another turn is active", () => {
  const accept = vi.fn();
  const reject = vi.fn();
  let active: string | undefined;
  const receive = hostMessageHandler(accept, reject, () => active);
  const delta = {
    version: PROTOCOL_VERSION,
    id: "before-reload",
    kind: "event",
    type: "turn.delta",
    payload: { text: "Old response" },
  };
  const tool = {
    version: PROTOCOL_VERSION,
    id: "before-reload",
    kind: "event",
    type: "tool.call",
    payload: { callId: "call", name: "spi_brief", arguments: {}, outcome: "completed" },
  };
  receive(delta);
  receive(tool);
  active = "current";
  receive(delta);
  receive(tool);
  expect(accept).not.toHaveBeenCalled();
  receive({ ...delta, id: active });
  receive({ ...tool, id: active });
  expect(accept).toHaveBeenCalledTimes(2);
  active = undefined;
  receive({ ...delta, id: "current" });
  expect(accept).toHaveBeenCalledTimes(2);
  expect(reject).not.toHaveBeenCalled();
});

it("ignores errors for requests not started by this window but keeps its catalog errors", () => {
  const accept = vi.fn();
  const receive = hostMessageHandler(
    accept,
    vi.fn(),
    () => undefined,
    (id) => id === "catalog",
  );
  const error = {
    version: PROTOCOL_VERSION,
    id: "before-reload",
    kind: "response",
    type: "error",
    payload: { code: "copilot_failed", message: "Old failure" },
  };
  receive(error);
  expect(accept).not.toHaveBeenCalled();
  receive({ ...error, id: "catalog" });
  expect(accept).toHaveBeenCalledExactlyOnceWith({ ...error, id: "catalog" });
});
