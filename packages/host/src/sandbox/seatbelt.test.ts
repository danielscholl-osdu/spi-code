// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ghConfigPath, runSandboxProbe } from "./probe.js";
import { sandboxEnvironment } from "./seatbelt.js";

describe.skipIf(process.platform !== "darwin")("Seatbelt probe", () => {
  it("runs Java, blocks credential reads and outside writes, and permits worktree writes", async () => {
    const report = await runSandboxProbe();
    expect(report.java.status).toBe(0);
    expect(report.java.version).toMatch(/version/u);
    expect(report.reads).toHaveLength(5);
    expect(report.reads.every((read) => !read.readable)).toBe(true);
    expect(report.fixtureReads).toHaveLength(5);
    expect(report.fixtureReads.every((read) => read.readableBefore && !read.readable)).toBe(true);
    expect(report.symlinkReads).toHaveLength(2);
    expect(report.symlinkReads.every((read) => read.readableBefore && !read.readable)).toBe(true);
    expect(report.unixSocket).toEqual({ connectedBefore: true, connected: false });
    expect(report.writes).toEqual({ outside: false, inside: true });
    expect(report.environment).toEqual(
      [
        "HOME",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_NOSYSTEM",
        "PATH",
        "TMPDIR",
        "XDG_CONFIG_HOME",
        ...["LANG", "LC_ALL", "TZ"].filter((key) => process.env[key] !== undefined),
      ].sort(),
    );
  }, 240_000);
});

it("allow-lists environment variables instead of inheriting credentials", () => {
  const env = sandboxEnvironment(process.cwd(), {
    GH_TOKEN: "fixture",
    GITHUB_TOKEN: "fixture",
    AZURE_CLIENT_SECRET: "fixture",
    ARM_ACCESS_KEY: "fixture",
    SSH_AUTH_SOCK: "/fixture",
    NODE_OPTIONS: "--require=/fixture",
    GIT_CONFIG_GLOBAL: "/untrusted/config",
    GIT_CONFIG_NOSYSTEM: "0",
    PATH: "/untrusted",
    LANG: "C",
  });
  expect(Object.keys(env).sort()).toEqual([
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
    "HOME",
    "LANG",
    "PATH",
    "TMPDIR",
    "XDG_CONFIG_HOME",
  ]);
  expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
  expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
  expect(env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
});

it("normalizes empty and relative gh configuration overrides", () => {
  const home = resolve("fixture-home");
  expect(ghConfigPath(home, { GH_CONFIG_DIR: "", XDG_CONFIG_HOME: "" })).toBe(
    resolve(home, ".config/gh"),
  );
  expect(ghConfigPath(home, { GH_CONFIG_DIR: "relative-gh" })).toBe(resolve("relative-gh"));
  expect(ghConfigPath(home, { GH_CONFIG_DIR: "", XDG_CONFIG_HOME: "relative-xdg" })).toBe(
    resolve("relative-xdg/gh"),
  );
});
