// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION } from "@spi-code/contracts";
import { expect, it, vi } from "vitest";
import { attachHostConnections, type HostConnection } from "./connections.js";

it("logs malformed connections, closes their ports and still accepts connections and reloads", () => {
  let receive: (event: HostConnection) => void = () => {};
  const connect = vi.fn();
  const log = vi.fn();
  const port = () => ({ on: vi.fn(), postMessage: vi.fn(), start: vi.fn(), close: vi.fn() });
  attachHostConnections(
    {
      on: (_event, listener) => {
        receive = listener;
      },
    },
    connect,
    log,
  );
  const rejected = port();
  receive({ data: { token: "private" }, ports: [rejected] });
  const ping = {
    version: PROTOCOL_VERSION,
    id: "connect",
    kind: "request",
    type: "ping",
    payload: {},
  };
  receive({ data: ping, ports: [] });
  const extra = [port(), port()];
  receive({ data: ping, ports: extra });
  expect(connect).not.toHaveBeenCalled();
  expect(rejected.close).toHaveBeenCalledOnce();
  for (const value of extra) expect(value.close).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(log.mock.calls)).not.toContain("private");
  const first = port();
  const second = port();
  receive({ data: ping, ports: [first] });
  receive({ data: null, ports: [] });
  expect(first.close).not.toHaveBeenCalled();
  receive({ data: ping, ports: [second] });
  expect(connect.mock.calls).toEqual([[first], [second]]);
  expect(first.close).toHaveBeenCalledOnce();
  expect(second.close).not.toHaveBeenCalled();
});
