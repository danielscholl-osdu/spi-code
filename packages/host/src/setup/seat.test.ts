// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CopilotClientOptions } from "@github/copilot-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeCopilotSeat, type SeatClient } from "./seat.js";

function fixture() {
  const session = { disconnect: vi.fn().mockResolvedValue(undefined) };
  const client = {
    start: vi.fn().mockResolvedValue(undefined),
    getAuthStatus: vi.fn().mockResolvedValue({ isAuthenticated: true }),
    createSession: vi.fn().mockResolvedValue(session),
    rpc: { models: { list: vi.fn().mockResolvedValue({ models: [{ id: "seat-model" }] }) } },
    stop: vi.fn().mockResolvedValue([]),
    forceStop: vi.fn().mockResolvedValue(undefined),
  } satisfies SeatClient;
  const createClient = vi.fn((_options: CopilotClientOptions): SeatClient => client);
  const options = {
    appDataDir: join(tmpdir(), "spicode-seat-fixture"),
    capturedPath: "/usr/bin:/bin",
    readToken: vi.fn().mockResolvedValue("gho_fixture"),
    createClient,
  };
  return { session, client, options };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Copilot seat probe", () => {
  it("requires a real session and explicit-token model listing, then closes both", async () => {
    const { session, client, options } = fixture();
    expect(await probeCopilotSeat(options)).toEqual({ kind: "seat-ok", models: ["seat-model"] });
    expect(client.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: "auto", availableTools: [] }),
    );
    const config = client.createSession.mock.calls[0]?.[0];
    expect(config).not.toHaveProperty("gitHubTokenProvider");
    expect(client.rpc.models.list).toHaveBeenCalledWith({ gitHubToken: "gho_fixture" });
    expect(session.disconnect).toHaveBeenCalledOnce();
    expect(client.stop).toHaveBeenCalledOnce();
  });

  it.each(["session", "models", "empty"])("reports authenticated-no-seat at %s", async (phase) => {
    const { session, client, options } = fixture();
    if (phase === "session") client.createSession.mockRejectedValue(new Error("403 Forbidden"));
    if (phase === "models") client.rpc.models.list.mockRejectedValue(new Error("403 Forbidden"));
    if (phase === "empty") client.rpc.models.list.mockResolvedValue({ models: [] });
    expect(await probeCopilotSeat(options)).toMatchObject({ kind: "no-seat" });
    expect(session.disconnect).toHaveBeenCalledTimes(phase === "session" ? 0 : 1);
    expect(client.stop).toHaveBeenCalledOnce();
  });

  it.each(["credential", "status", "401"])("reports sign-in at %s", async (phase) => {
    const { client, options } = fixture();
    if (phase === "credential")
      options.readToken.mockRejectedValue(new Error("gh auth token failed."));
    if (phase === "status") client.getAuthStatus.mockResolvedValue({ isAuthenticated: false });
    if (phase === "401") client.rpc.models.list.mockRejectedValue(new Error("401 Unauthorized"));
    expect(await probeCopilotSeat(options)).toMatchObject({ kind: "sign-in" });
    expect(client.stop).toHaveBeenCalledTimes(phase === "credential" ? 0 : 1);
    if (phase !== "401") expect(client.createSession).not.toHaveBeenCalled();
  });

  it("explains classic ghp_ credentials without sending or exposing the token", async () => {
    const { options } = fixture();
    options.readToken.mockResolvedValue("ghp_classicSecret");
    const result = await probeCopilotSeat(options);
    expect(result).toMatchObject({
      kind: "sign-in",
      reason: expect.stringMatching(/classic ghp_.*OAuth/u),
    });
    expect(JSON.stringify(result)).not.toContain("ghp_classicSecret");
    expect(options.createClient).not.toHaveBeenCalled();
  });

  it.each(["", "gho_invalid token", "gho_bad\0token"])(
    "rejects malformed credentials",
    async (token) => {
      const { options } = fixture();
      options.readToken.mockResolvedValue(token);
      expect(await probeCopilotSeat(options)).toMatchObject({ kind: "sign-in" });
      expect(options.createClient).not.toHaveBeenCalled();
    },
  );

  it.each(["startup", "authentication", "session", "models"])(
    "keeps SDK/network failures distinct from no-seat at %s and redacts errors",
    async (phase) => {
      const { session, client, options } = fixture();
      const failure = new Error("network failed gho_fixture github_pat_otherSecret");
      if (phase === "startup") client.start.mockRejectedValue(failure);
      if (phase === "authentication") client.getAuthStatus.mockRejectedValue(failure);
      if (phase === "session") client.createSession.mockRejectedValue(failure);
      if (phase === "models") client.rpc.models.list.mockRejectedValue(failure);
      expect(await probeCopilotSeat(options)).toEqual({
        kind: "error",
        reason: "network failed [redacted] [redacted]",
      });
      expect(session.disconnect).toHaveBeenCalledTimes(phase === "models" ? 1 : 0);
      expect(client.stop).toHaveBeenCalledOnce();
    },
  );

  it.each(["credential", "startup", "session", "models", "disconnect", "stop"])(
    "bounds a hung %s and still stops the owned client",
    async (phase) => {
      vi.useFakeTimers();
      const { session, client, options } = fixture();
      const hanging = () => new Promise<never>(() => {});
      if (phase === "credential") options.readToken.mockImplementation(hanging);
      if (phase === "startup") client.start.mockImplementation(hanging);
      if (phase === "session") client.createSession.mockImplementation(hanging);
      if (phase === "models") client.rpc.models.list.mockImplementation(hanging);
      if (phase === "disconnect") session.disconnect.mockImplementation(hanging);
      if (phase === "stop") client.stop.mockImplementation(hanging);
      const pending = probeCopilotSeat({ ...options, timeoutMs: 10, cleanupTimeoutMs: 5 });
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({
        kind: "error",
        reason: expect.stringContaining("timed out"),
      });
      expect(client.stop).toHaveBeenCalledTimes(phase === "credential" ? 0 : 1);
      expect(session.disconnect).toHaveBeenCalledTimes(
        ["models", "disconnect", "stop"].includes(phase) ? 1 : 0,
      );
      if (["startup", "session", "models", "stop"].includes(phase)) {
        expect(client.forceStop).toHaveBeenCalledOnce();
      }
    },
  );

  it("reports failed shutdown and force-stop without leaking credentials", async () => {
    const { client, options } = fixture();
    client.stop.mockResolvedValue([new Error("stop gho_fixture")]);
    client.forceStop.mockRejectedValue(new Error("force gho_fixture"));
    expect(await probeCopilotSeat(options)).toEqual({
      kind: "error",
      reason: "Copilot cleanup failed; Copilot shutdown failed.; stop [redacted]; force [redacted]",
    });
  });

  it("writes only within the runtime's isolated app-data directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "spicode-seat-"));
    try {
      const home = join(root, "home");
      const appDataDir = join(root, "app");
      await mkdir(home);
      await mkdir(appDataDir);
      await writeFile(join(home, "sentinel"), "unchanged");
      const { client, options } = fixture();
      options.createClient.mockImplementation((config) => {
        expect(config).toMatchObject({
          mode: "empty",
          baseDirectory: join(appDataDir, "copilot"),
          workingDirectory: appDataDir,
          useLoggedInUser: false,
        });
        expect(config.env).not.toHaveProperty("GH_TOKEN");
        client.start.mockImplementation(async () => {
          await mkdir(config.baseDirectory ?? "", { recursive: true });
          await writeFile(join(config.baseDirectory ?? "", "session"), "probe");
        });
        return client;
      });
      expect(
        await probeCopilotSeat({
          ...options,
          appDataDir,
          env: {
            HOME: home,
            USERPROFILE: home,
            XDG_CONFIG_HOME: home,
            XDG_CACHE_HOME: home,
            APPDATA: home,
            LOCALAPPDATA: home,
            GH_TOKEN: "stray",
          },
        }),
      ).toMatchObject({ kind: "seat-ok" });
      expect(await readdir(root)).toEqual(["app", "home"]);
      expect(await readdir(home)).toEqual(["sentinel"]);
      expect(await readFile(join(home, "sentinel"), "utf8")).toBe("unchanged");
      expect(await readdir(appDataDir, { recursive: true })).toEqual([
        "copilot",
        "copilot/session",
      ]);
      expect(await readFile(join(appDataDir, "copilot/session"), "utf8")).not.toContain(
        "gho_fixture",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
