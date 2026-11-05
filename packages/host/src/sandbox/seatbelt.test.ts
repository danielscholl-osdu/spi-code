// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ghConfigPath, runSandboxProbe } from "./probe.js";
import { refuseCredentialHardLinks, sandboxEnvironment, seatbeltProfile } from "./seatbelt.js";

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
    expect(report.hardLinkGuard).toEqual({ launchRefused: true, commandRan: false });
    expect(report.missingChildReads).toHaveLength(2);
    expect(
      report.missingChildReads.every(
        (read) => read.absentAtProfileCreation && read.readableBefore && !read.readable,
      ),
    ).toBe(true);
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

it("refuses a protected directory scan beyond the depth limit", () => {
  const root = mkdtempSync(join(tmpdir(), "spi-seatbelt-depth-"));
  try {
    const options = {
      worktree: join(root, "worktree"),
      scratchHome: join(root, "scratch"),
      protectedHome: join(root, "home"),
    };
    for (const path of Object.values(options)) mkdirSync(path);
    const ssh = join(options.protectedHome, ".ssh");
    let path = ssh;
    mkdirSync(path);
    for (let depth = 0; depth < 16; depth++) {
      path = join(path, "nested");
      mkdirSync(path);
    }
    expect(() => refuseCredentialHardLinks([ssh])).not.toThrow();
    if (process.platform !== "win32") expect(() => seatbeltProfile(options)).not.toThrow();
    mkdirSync(join(path, "too-deep"));
    expect(() => refuseCredentialHardLinks([ssh])).toThrow(
      /protected credential scan limit exceeded/u,
    );
    expect(() => seatbeltProfile(options)).toThrow(/protected credential scan limit exceeded/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
