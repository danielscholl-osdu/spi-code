// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { isAbsolute, join } from "node:path";
import type { CopilotClientOptions } from "@github/copilot-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildClientOptions,
  buildSessionOptions,
  CopilotRuntime,
  listModelsWithToken,
  resolveRuntimePath,
  stubToolSource,
  tokenLifetimeSeconds,
} from "./runtime.js";

const fake = vi.hoisted(() => ({
  configs: [] as CopilotClientOptions[],
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue([]),
  createSession: vi.fn().mockRejectedValue(new Error("session stub")),
  list: vi.fn().mockResolvedValue({ models: [] }),
}));

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: class {
    constructor(config: CopilotClientOptions) {
      fake.configs.push(config);
    }
    start = fake.start;
    stop = fake.stop;
    createSession = fake.createSession;
    rpc = { models: { list: fake.list } };
  },
}));

describe("Copilot runtime boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fake.configs.length = 0;
  });
  it("starts the platform runtime explicitly over stdio in isolated empty mode", () => {
    const cliPath = resolveRuntimePath();
    expect(isAbsolute(cliPath)).toBe(true);
    expect(cliPath).toContain("prebuilds");
    const options = buildClientOptions({
      appDataDir: "/tmp/spicode-app",
      cliPath,
      capturedPath: "/usr/bin:/bin",
      env: {
        HOME: "/tmp/operator",
        GH_TOKEN: "stray",
        github_token: "stray",
        COPILOT_GITHUB_TOKEN: "stray",
      },
    });
    expect(options).toMatchObject({
      connection: { kind: "stdio", path: cliPath },
      mode: "empty",
      baseDirectory: join("/tmp/spicode-app", "copilot"),
      useLoggedInUser: false,
      workingDirectory: "/tmp/spicode-app",
    });
    expect(options.env).not.toHaveProperty("GH_TOKEN");
    expect(options.env).not.toHaveProperty("github_token");
    expect(options.env).not.toHaveProperty("COPILOT_GITHUB_TOKEN");
    expect(options).not.toHaveProperty("gitHubToken");
  });

  it("gets fresh session credentials with a fixed lifetime and registry policy", async () => {
    const readToken = vi.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    const options = buildSessionOptions(readToken, stubToolSource);
    expect(options.streaming).toBe(true);
    expect(options.availableTools).toEqual([]);
    expect(options.onPermissionRequest).toBe(stubToolSource.onPermissionRequest);
    expect(await options.gitHubTokenProvider?.({ host: "github.com", reason: "initial" })).toEqual({
      kind: "token",
      accessToken: "first",
      expiresIn: tokenLifetimeSeconds,
    });
    expect(await options.gitHubTokenProvider?.({ host: "github.com", reason: "refresh" })).toEqual({
      kind: "token",
      accessToken: "second",
      expiresIn: 60,
    });
    readToken.mockRejectedValueOnce(new Error("signed out"));
    await expect(
      options.gitHubTokenProvider?.({ host: "github.com", reason: "initial" }),
    ).rejects.toThrow("signed out");
  });

  it("never uses a tokenless or cached model listing, including after account switches", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ models: ["first"] })
      .mockRejectedValueOnce(new Error("unauthorized"))
      .mockResolvedValueOnce({ models: ["first-again"] });
    const client = { rpc: { models: { list } } };
    expect(await listModelsWithToken(client, "first")).toEqual({ models: ["first"] });
    await expect(listModelsWithToken(client, "invalid")).rejects.toThrow("unauthorized");
    expect(await listModelsWithToken(client, "first")).toEqual({ models: ["first-again"] });
    expect(list.mock.calls).toEqual([
      [{ gitHubToken: "first" }],
      [{ gitHubToken: "invalid" }],
      [{ gitHubToken: "first" }],
    ]);
  });

  it("drops the warm client on token changes and wires policy without the unfit provider", async () => {
    let token = "real";
    const runtime = new CopilotRuntime(
      { appDataDir: "/tmp/spicode", capturedPath: "/bin" },
      async () => token,
    );
    await runtime.start();
    await runtime.listModels();
    await expect(runtime.createSession()).rejects.toThrow("session stub");
    expect(fake.createSession.mock.calls[0]?.[0]).not.toHaveProperty("gitHubTokenProvider");
    expect(fake.createSession.mock.calls[0]?.[0]).toMatchObject({
      availableTools: [],
      onPermissionRequest: stubToolSource.onPermissionRequest,
    });
    token = "invalid";
    fake.list.mockRejectedValueOnce(new Error("unauthorized"));
    await expect(runtime.listModels()).rejects.toThrow("unauthorized");
    token = "real";
    await runtime.listModels();
    expect(fake.configs.map((config) => config.gitHubToken)).toEqual(["real", "invalid", "real"]);
    expect(fake.stop).toHaveBeenCalledTimes(2);
    expect(fake.list.mock.calls).toEqual([
      [{ gitHubToken: "real" }],
      [{ gitHubToken: "invalid" }],
      [{ gitHubToken: "real" }],
    ]);
    await runtime.stop();
    expect(fake.stop).toHaveBeenCalledTimes(3);
  });

  it("cleans up a failed start before retrying with a fresh credential", async () => {
    const runtime = new CopilotRuntime(
      { appDataDir: "/tmp/spicode", capturedPath: "/bin" },
      vi.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("second"),
    );
    fake.start.mockRejectedValueOnce(new Error("spawn failed"));
    await expect(runtime.start()).rejects.toThrow("spawn failed");
    await runtime.listModels();
    expect(fake.configs.map((config) => config.gitHubToken)).toEqual(["first", "second"]);
    expect(fake.stop).toHaveBeenCalledTimes(1);
    await runtime.stop();
  });

  it("serializes simultaneous listings so token changes cannot stop an in-flight request", async () => {
    let finishListing: (value: { models: never[] }) => void = () => {};
    fake.list.mockImplementationOnce(
      () =>
        new Promise<{ models: never[] }>((resolve) => {
          finishListing = resolve;
        }),
    );
    const readToken = vi.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    const runtime = new CopilotRuntime(
      { appDataDir: "/tmp/spicode", capturedPath: "/bin" },
      readToken,
    );
    const requests = Promise.all([runtime.listModels(), runtime.listModels()]);
    await vi.waitFor(() => expect(fake.list).toHaveBeenCalledTimes(1));
    expect(readToken).toHaveBeenCalledTimes(1);
    expect(fake.stop).not.toHaveBeenCalled();
    finishListing({ models: [] });
    await requests;
    expect(fake.list.mock.calls).toEqual([[{ gitHubToken: "first" }], [{ gitHubToken: "second" }]]);
    expect(fake.stop).toHaveBeenCalledTimes(1);
    await runtime.stop();
  });
});
