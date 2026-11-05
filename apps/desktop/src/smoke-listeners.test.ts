// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { listenersOf, windowsListeners } from "./smoke-listeners.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const ipv4 = "  TCP    0.0.0.0:9222           0.0.0.0:0              LISTENING       42";
const ipv6 = "  TCP    [::]:9223              [::]:0                 LISTENING       42";
const output = [
  "",
  "Active Connections",
  "",
  "  Proto  Local Address          Foreign Address        State           PID",
  ipv4,
  ipv6,
  "  TCP    127.0.0.1:5000         127.0.0.1:443          ESTABLISHED     42",
  "  TCP    [::1]:5001             [::1]:443              ESTABLISHED     42",
  "  TCP    0.0.0.0:9224           0.0.0.0:0              LISTENING       142",
  "  UDP    0.0.0.0:5353           *:*                                    42",
  "  UDP    [::]:5353              *:*                                    42",
].join("\r\n");

describe("Windows TCP listener evidence", () => {
  it("finds IPv4 and IPv6 listeners for exactly the requested pid", () => {
    expect(windowsListeners(output, 42)).toEqual([ipv4, ipv6]);
    expect(windowsListeners(output, 7)).toEqual([]);
  });

  it("also parses an explicit TCPv6 protocol label", () => {
    const row = "  TCPv6  [::]:9223              [::]:0                 LISTENING       42";
    expect(windowsListeners(row, 42)).toEqual([row]);
  });

  it("does not mistake SYN_SENT with a zero foreign port for a listener", () => {
    const row = "  TCP    192.0.2.1:5000         0.0.0.0:0              SYN_SENT        42";
    expect(windowsListeners(row, 42)).toEqual([]);
  });

  it("requests both IP families from netstat and checks process liveness", () => {
    const platform = process.platform;
    const exec = vi.mocked(execFileSync).mockReturnValue(output);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      expect(listenersOf(42)).toEqual([ipv4, ipv6]);
      expect(exec).toHaveBeenCalledWith(
        "netstat.exe",
        ["-ano"],
        expect.objectContaining({ encoding: "utf8", timeout: 10000 }),
      );
      expect(kill.mock.calls).toEqual([
        [42, 0],
        [42, 0],
      ]);
    } finally {
      Object.defineProperty(process, "platform", { value: platform });
      vi.restoreAllMocks();
    }
  });

  it("rejects malformed TCP evidence rather than treating it as no listeners", () => {
    expect(() => windowsListeners("  TCP    0.0.0.0:80    0.0.0.0:0", 42)).toThrow(
      "Unexpected netstat TCP row",
    );
  });
});
