// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { windowsListeners } from "./smoke-listeners.js";

describe("Windows TCP listener evidence", () => {
  it("finds IPv4 and IPv6 listeners for exactly the requested pid", () => {
    const ipv4 = "  TCP    0.0.0.0:9222    0.0.0.0:0    LISTENING    42";
    const ipv6 = "  TCP    [::]:9223      [::]:0       LISTENING    42";
    const output = [
      "Active Connections",
      "  Proto  Local Address  Foreign Address  State  PID",
      ipv4,
      ipv6,
      "  TCP    127.0.0.1:5000  127.0.0.1:443  ESTABLISHED  42",
      "  TCP    0.0.0.0:9224    0.0.0.0:0     LISTENING    142",
    ].join("\r\n");
    expect(windowsListeners(output, 42)).toEqual([ipv4, ipv6]);
    expect(windowsListeners(output, 7)).toEqual([]);
  });

  it("does not depend on the localized state label", () => {
    const row = "  TCP    127.0.0.1:9222    0.0.0.0:0    ECOUTE    42";
    expect(windowsListeners(row, 42)).toEqual([row]);
  });

  it("rejects malformed TCP evidence rather than treating it as no listeners", () => {
    expect(() => windowsListeners("  TCP    0.0.0.0:80    0.0.0.0:0", 42)).toThrow(
      "Unexpected netstat TCP row",
    );
  });
});
