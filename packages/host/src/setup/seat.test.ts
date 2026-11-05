// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdtempSync } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CopilotClientOptions } from "@github/copilot-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeCopilotSeat, type SeatClient } from "./seat.js";

const fixtureDirectories: string[] = [];

function fixture() {
  const appDataDir = mkdtempSync(join(tmpdir(), "spicode-seat-fixture-"));
  fixtureDirectories.push(appDataDir);
  const session = { disconnect: vi.fn().mockResolvedValue(undefined) };
  const client = {
    start: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue(session),
    rpc: { models: { list: vi.fn().mockResolvedValue({ models: [{ id: "seat-model" }] }) } },
    stop: vi.fn().mockResolvedValue([]),
    forceStop: vi.fn().mockResolvedValue(undefined),
  } satisfies SeatClient;
  const createClient = vi.fn((_options: CopilotClientOptions): SeatClient => client);
  const options = {
    appDataDir,
    capturedPath: "/usr/bin:/bin",
    readToken: vi.fn().mockResolvedValue("gho_fixture"),
    createClient,
  };
  return { session, client, options };
}

afterEach(async () => {
  await Promise.all(
    fixtureDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
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

  it.each(["success", "403", "404"])(
    "ignores the misleading unauthenticated status when the actual outcome is %s",
    async (outcome) => {
      const { client, options } = fixture();
      const getAuthStatus = vi.fn().mockResolvedValue({ isAuthenticated: false });
      Object.assign(client, { getAuthStatus });
      if (outcome !== "success") {
        client.rpc.models.list.mockRejectedValue(
          new Error(`Failed to fetch Copilot user info: ${outcome}`),
        );
      }
      expect(await probeCopilotSeat(options)).toMatchObject({
        kind: outcome === "success" ? "seat-ok" : "no-seat",
      });
      expect(client.createSession).toHaveBeenCalledOnce();
      expect(client.rpc.models.list).toHaveBeenCalledOnce();
      expect(getAuthStatus).not.toHaveBeenCalled();
    },
  );

  it.each(["session", "models"])(
    "reports no-seat from %s without an auth-status check",
    async (phase) => {
      for (const message of [
        "403 Forbidden",
        "404 Not Found",
        "Failed to fetch Copilot user info: 403 Forbidden",
        "Failed to fetch Copilot user info: 404 Not Found",
        "forbidden",
        "not authorized",
        "no access to Copilot",
        "no entitled models",
      ]) {
        const { session, client, options } = fixture();
        const operation = phase === "session" ? client.createSession : client.rpc.models.list;
        operation.mockRejectedValue(new Error(message));
        expect(await probeCopilotSeat(options)).toEqual({ kind: "no-seat", reason: message });
        expect(session.disconnect).toHaveBeenCalledTimes(phase === "session" ? 0 : 1);
        expect(client.stop).toHaveBeenCalledOnce();
      }
    },
  );

  it("reports no-seat for an empty entitled-model list", async () => {
    const { session, client, options } = fixture();
    client.rpc.models.list.mockResolvedValue({ models: [] });
    expect(await probeCopilotSeat(options)).toMatchObject({ kind: "no-seat" });
    expect(session.disconnect).toHaveBeenCalledOnce();
    expect(client.stop).toHaveBeenCalledOnce();
  });

  it("reports sign-in when gh has no credential", async () => {
    const { client, options } = fixture();
    options.readToken.mockRejectedValue(new Error("gh auth token failed."));
    expect(await probeCopilotSeat(options)).toMatchObject({ kind: "sign-in" });
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it.each(["session", "models"])(
    "reports sign-in for rejected credentials at %s",
    async (phase) => {
      for (const message of ["401 Unauthorized", "Bad credentials"]) {
        const { client, options } = fixture();
        const operation = phase === "session" ? client.createSession : client.rpc.models.list;
        operation.mockRejectedValue(new Error(message));
        expect(await probeCopilotSeat(options)).toEqual({ kind: "sign-in", reason: message });
        expect(client.stop).toHaveBeenCalledOnce();
      }
    },
  );

  it("explains classic ghp_ credentials without sending or exposing the token", async () => {
    const { options } = fixture();
    options.readToken.mockResolvedValue("ghp_classicSecret");
    const result = await probeCopilotSeat(options);
    expect(result).toMatchObject({
      kind: "sign-in",
      classicToken: true,
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

  it.each(["startup", "session", "models"])(
    "keeps SDK/network failures distinct from no-seat at %s and redacts errors",
    async (phase) => {
      const { session, client, options } = fixture();
      const failure = new Error("network failed gho_fixture github_pat_otherSecret");
      if (phase === "startup") client.start.mockRejectedValue(failure);
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
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const { session, client, options } = fixture();
        let entered: () => void = () => {};
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const hanging = () => {
          entered();
          return new Promise<never>(() => {});
        };
        if (phase === "credential") options.readToken.mockImplementation(hanging);
        if (phase === "startup") client.start.mockImplementation(hanging);
        if (phase === "session") client.createSession.mockImplementation(hanging);
        if (phase === "models") client.rpc.models.list.mockImplementation(hanging);
        if (phase === "disconnect") session.disconnect.mockImplementation(hanging);
        if (phase === "stop") client.stop.mockImplementation(hanging);
        const pending = probeCopilotSeat({ ...options, timeoutMs: 10, cleanupTimeoutMs: 5 });
        const outcome = expect(pending).resolves.toMatchObject({
          kind: "error",
          reason: expect.stringContaining("timed out"),
        });
        await started;
        await vi.runAllTimersAsync();
        await outcome;
        expect(client.stop).toHaveBeenCalledTimes(phase === "credential" ? 0 : 1);
        expect(session.disconnect).toHaveBeenCalledTimes(
          ["models", "disconnect", "stop"].includes(phase) ? 1 : 0,
        );
        if (["startup", "session", "models", "stop"].includes(phase)) {
          expect(client.forceStop).toHaveBeenCalledOnce();
        }
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("caps the credential read at five seconds independently of the session timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { options } = fixture();
      let entered: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      options.readToken.mockImplementation(() => {
        entered();
        return new Promise<never>(() => {});
      });
      let settled = false;
      const pending = probeCopilotSeat(options).then((result) => {
        settled = true;
        return result;
      });
      await started;
      await vi.advanceTimersByTimeAsync(4999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      await expect(pending).resolves.toMatchObject({
        kind: "error",
        reason: expect.stringContaining("timed out"),
      });
      expect(options.createClient).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it.each(["gho_", "ghp_", "ghr_", "ghs_", "ghu_", "github_pat_"])(
    "redacts %s tokens from non-Error SDK rejections",
    async (prefix) => {
      for (const rejection of [
        `SDK failed ${prefix}otherSecret`,
        { message: `SDK failed ${prefix}otherSecret` },
      ]) {
        const { client, options } = fixture();
        client.rpc.models.list.mockRejectedValue(rejection);
        expect(await probeCopilotSeat(options)).toEqual({
          kind: "error",
          reason: "SDK failed [redacted]",
        });
      }
    },
  );

  it("creates the first-launch cwd and isolated directory before starting the client", async () => {
    const { client, options } = fixture();
    options.appDataDir = join(options.appDataDir, "not-created", "app");
    client.start.mockImplementation(async () => {
      await access(options.appDataDir);
      await access(join(options.appDataDir, "copilot"));
    });
    expect(await probeCopilotSeat(options)).toMatchObject({ kind: "seat-ok" });
    expect(client.start).toHaveBeenCalledOnce();
  });

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
    // Proves the probe's writes/configuration with a cooperative fake, not SDK filesystem isolation.
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
          await access(config.baseDirectory ?? "");
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
