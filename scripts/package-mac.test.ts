// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { assertRuntimeEvidence, packagingEnvironment } from "./package-mac.mjs";

describe("packaged smoke gate", () => {
  const resources = "/artifacts/SPI Code.app/Contents/Resources";
  const evidence = {
    hostPid: 42,
    runtimePath: `${resources}/app.asar.unpacked/node_modules/@github/copilot-sdk-darwin-arm64/prebuilds/darwin-arm64/copilot-runtime`,
    transport: "stdio",
    ping: { message: "pong: spi-code-packaged-smoke", timestamp: "2026-11-05T00:00:00Z" },
    status: { protocolVersion: 1, version: "1.0.103" },
  };
  it("accepts a protocol response from the shipped binary in the observed host", () => {
    expect(() => assertRuntimeEvidence({ hostPid: 42 }, evidence, resources)).not.toThrow();
  });
  it.each([
    { ...evidence, hostPid: 43 },
    { ...evidence, runtimePath: evidence.runtimePath.replace("app.asar.unpacked", "app.asar") },
    { ...evidence, runtimePath: "/usr/local/bin/copilot-runtime" },
    { ...evidence, transport: "tcp" },
    { ...evidence, ping: undefined },
    { ...evidence, status: { protocolVersion: 0, version: "1.0.103" } },
    { ...evidence, ping: { message: "pong: spi-code-packaged-smoke", timestamp: "invalid" } },
    { ...evidence, status: { protocolVersion: 1 } },
  ])("rejects missing or mismatched runtime proof %#", (invalid) => {
    expect(() => assertRuntimeEvidence({ hostPid: 42 }, invalid, resources)).toThrow();
  });
  it("removes Node boot and signing overrides without enabling environment stub mode", () => {
    expect(
      packagingEnvironment({
        PATH: "/bin",
        ELECTRON_RUN_AS_NODE: "1",
        CSC_LINK: "certificate",
        CSC_KEY_PASSWORD: "password",
        CSC_IDENTITY_AUTO_DISCOVERY: "true",
        APPLE_API_KEY: "key",
        SPI_CODE_STUB_MODEL: "1",
      }),
    ).toEqual({ PATH: "/bin", CSC_IDENTITY_AUTO_DISCOVERY: "false" });
  });
});
