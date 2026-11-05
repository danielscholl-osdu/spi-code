// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION } from "@spi-code/contracts";
import { expect, it, vi } from "vitest";
import { hostMessageHandler } from "./host-message.js";

it("rejects malformed host messages and wrong-way requests without dispatching or replying", () => {
  const accept = vi.fn();
  const reject = vi.fn();
  const receive = hostMessageHandler(accept, reject);
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
