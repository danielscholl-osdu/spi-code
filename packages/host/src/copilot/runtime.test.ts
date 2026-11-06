// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative } from "node:path";
import { inspect } from "node:util";
import type { CopilotClientOptions } from "@github/copilot-sdk";
import { createToolInstaller } from "@spi-code/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ghAuthToken } from "../env/shell-environment.js";
import * as toolEnvironment from "../env/tool-environment.js";
import { HostExec } from "../exec/host-exec.js";
import { createConversationBackend } from "../process/conversation.js";
import { probeCopilotSeat } from "../setup/seat.js";
import {
  buildAuthEnvironment,
  buildClientOptions,
  buildSessionOptions,
  CopilotRuntime,
  listModelsWithToken,
  resolveRuntimePath,
  streamTurn,
  stubToolSource,
  tokenLifetimeSeconds,
  unpackRuntimePath,
} from "./runtime.js";

const fake = vi.hoisted(() => ({
  configs: [] as CopilotClientOptions[],
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue([]),
  createSession: vi.fn().mockRejectedValue(new Error("session stub")),
  list: vi.fn().mockResolvedValue({ models: [] }),
  construct: vi.fn(),
}));

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: class {
    constructor(config: CopilotClientOptions) {
      fake.construct(config);
      fake.configs.push(config);
    }
    start = fake.start;
    stop = fake.stop;
    createSession = fake.createSession;
    rpc = { models: { list: fake.list } };
  },
}));

vi.mock("../env/shell-environment.js", async (original) => ({
  ...(await original<typeof import("../env/shell-environment.js")>()),
  captureLoginShellPath: async () => ({ path: "", captured: true, failures: [] }),
}));

describe("Copilot runtime boundary", () => {
  it("resolves only the archive path segment to its unpacked sibling on both platforms", () => {
    expect(unpackRuntimePath("/App/Resources/app.asar/node_modules/runtime")).toBe(
      "/App/Resources/app.asar.unpacked/node_modules/runtime",
    );
    expect(unpackRuntimePath("C:\\App\\resources\\app.asar\\node_modules\\runtime.exe")).toBe(
      "C:\\App\\resources\\app.asar.unpacked\\node_modules\\runtime.exe",
    );
    for (const path of [
      "/dev/node_modules/runtime",
      "/App/Resources/app.asar.unpacked/node_modules/runtime",
      "/app.asar-backup/node_modules/runtime",
    ])
      expect(unpackRuntimePath(path)).toBe(path);
  });

  beforeEach(() => {
    vi.resetAllMocks();
    fake.start.mockResolvedValue(undefined);
    fake.stop.mockResolvedValue([]);
    fake.createSession.mockRejectedValue(new Error("session stub"));
    fake.list.mockResolvedValue({ models: [] });
    fake.configs.length = 0;
  });

  it.each(["normal", "sentinel"] as const)(
    "shares the %s managed environment between auth, the runtime child and HostExec",
    async (builder) => {
      const root = await mkdtemp(join(tmpdir(), "spicode-shared-env-"));
      const appDataDir = join(root, "app");
      const ghBin = join(appDataDir, "tools", "gh", "2.83.0", "bin");
      const glabBin = join(appDataDir, "tools", "glab", "1.0.0", "bin");
      const shellBin = join(root, "shell-bin");
      const capturedPath = [shellBin, ghBin].join(delimiter);
      const env = {
        PATH: "foreign",
        KUBECONFIG: "foreign",
        AZURE_CONFIG_DIR: "foreign",
        GH_TOKEN: "obviously-fake-inherited-token",
        GITHUB_TOKEN: "obviously-fake-inherited-token",
        COPILOT_GITHUB_TOKEN: "obviously-fake-inherited-token",
      };
      const installer = {
        binDir: async (tool: string) =>
          tool === "gh" ? ghBin : tool === "glab" ? glabBin : undefined,
      };
      const options = { appDataDir, capturedPath, installer, env };
      const runtime = new CopilotRuntime(options, async () => "obviously-fake-sdk-token");
      const createEnvironment = toolEnvironment.createManagedToolEnvironment;
      const shared = vi.spyOn(toolEnvironment, "createManagedToolEnvironment");
      const expected = {
        PATH:
          builder === "sentinel"
            ? join(root, "shared-builder-only")
            : [ghBin, glabBin, shellBin].join(delimiter),
        KUBECONFIG:
          builder === "sentinel"
            ? join(root, "shared-builder-config")
            : join(appDataDir, "kube", "config"),
        AZURE_CONFIG_DIR: join(appDataDir, "azure"),
      };
      if (builder === "sentinel") {
        shared.mockImplementation(async (options) => ({
          ...(await createEnvironment(options)),
          ...expected,
        }));
      }
      try {
        await mkdir(appDataDir);
        const legacyConfig = join(appDataDir, "kubeconfig");
        await writeFile(legacyConfig, "legacy configuration fixture");
        const authEnv = await buildAuthEnvironment(options);
        const result = await new HostExec({
          appData: appDataDir,
          capturedPath,
          installer,
          env,
        }).runJSON(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"]);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error);
        await runtime.start();
        for (const actual of [authEnv, result.data, fake.configs.at(-1)?.env]) {
          expect(actual).toMatchObject(expected);
          for (const token of ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN"]) {
            expect(actual).not.toHaveProperty(token);
          }
        }
        expect(await readFile(legacyConfig, "utf8")).toBe("legacy configuration fixture");
      } finally {
        await runtime.stop();
        shared.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "prefers managed gh over a login-shell decoy after installation without leaking credentials",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "spicode-managed-gh-"));
      const appDataDir = join(root, "app");
      const token = "gho_obviouslyFakeManagedFixture";
      const tools = await createToolInstaller(appDataDir, "darwin-arm64");
      const bin = join(appDataDir, "tools", "gh", "2.83.0", "bin");
      const logs = ["log", "info", "warn", "error", "debug"] as const;
      const spies = logs.map((name) => vi.spyOn(console, name).mockImplementation(() => {}));
      const options = {
        appDataDir,
        capturedPath: "",
        installer: tools,
        env: { GH_TOKEN: token, GITHUB_TOKEN: token, COPILOT_GITHUB_TOKEN: token },
      };
      const runtime = new CopilotRuntime(options);
      try {
        await expect(runtime.start()).rejects.toThrow("gh auth token failed.");
        await mkdir(bin, { recursive: true });
        await writeFile(
          join(bin, "gh"),
          `#!/bin/sh\n[ "$1 $2" = "auth token" ] || exit 2\n[ -z "$GH_TOKEN$GITHUB_TOKEN$COPILOT_GITHUB_TOKEN" ] || exit 3\nprintf '${token}\\n'\n`,
          { mode: 0o700 },
        );
        await symlink("2.83.0", join(appDataDir, "tools", "gh", "current"));
        expect(await tools.binDir("gh")).toBe(bin);
        await runtime.start();
        expect(fake.configs.at(-1)?.gitHubToken).toBe(token);
        const pathBin = join(root, "shell-bin");
        const decoyToken = "gho_obviouslyFakeLoginShellDecoy";
        await mkdir(pathBin);
        await writeFile(join(pathBin, "gh"), `#!/bin/sh\nprintf '${decoyToken}\\n'\n`, {
          mode: 0o700,
        });
        options.capturedPath = pathBin;
        await runtime.listModels();
        expect(fake.list).toHaveBeenLastCalledWith({ gitHubToken: token });
        const authEnv = await buildAuthEnvironment(options);
        expect(authEnv.PATH?.split(delimiter)).toEqual([bin, pathBin]);
        expect(inspect(authEnv)).not.toContain(token);
        expect(inspect(authEnv)).not.toContain(decoyToken);
        expect(inspect(fake.configs.at(-1)?.env)).not.toContain(token);
        fake.createSession.mockResolvedValueOnce({ disconnect: vi.fn() });
        fake.list.mockResolvedValueOnce({ models: [{ id: "seat-model" }] });
        expect(await probeCopilotSeat(options)).toEqual({
          kind: "seat-ok",
          models: ["seat-model"],
        });
        const backend = await createConversationBackend(appDataDir, false, () => {}, tools);
        try {
          expect(await backend.models()).toEqual([]);
          expect(fake.configs.at(-1)?.gitHubToken).toBe(token);
          expect(fake.configs.at(-1)?.env?.PATH?.split(delimiter)).toEqual([bin]);
        } finally {
          await backend.stop();
        }
        fake.list.mockRejectedValueOnce(new Error(`SDK failed with ${token}`));
        const error: unknown = await runtime.listModels().catch((error: unknown) => error);
        expect(error).toBeInstanceOf(Error);
        expect(inspect(error, { depth: null })).not.toContain(token);
        expect(inspect(error, { depth: null })).toContain("[redacted]");
        await writeFile(
          join(bin, "gh"),
          `#!/bin/sh\nprintf '${token}'; printf '${token}' >&2; exit 1\n`,
          { mode: 0o700 },
        );
        const authError: unknown = await runtime.listModels().catch((error: unknown) => error);
        expect(authError).toBeInstanceOf(Error);
        expect(inspect(authError, { depth: null })).not.toContain(token);
        expect(inspect(authError)).toContain("gh auth token failed.");
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      } finally {
        await runtime.stop();
        for (const spy of spies) spy.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32").each(["runtime", "seat"])(
    "%s uses the github.com credential instead of an enterprise default",
    async (consumer) => {
      const root = await mkdtemp(join(tmpdir(), "spicode-gh-host-"));
      const token = "gho_obviouslyFakeGithubComAccount";
      const enterpriseToken = "gho_obviouslyFakeEnterpriseAccount";
      const options = {
        appDataDir: join(root, "app"),
        capturedPath: root,
        env: { GH_HOST: "enterprise.example.test" },
      };
      try {
        await writeFile(
          join(root, "gh"),
          `#!/bin/sh\n[ "$1 $2" = "auth token" ] || exit 2\n[ -z "$GH_HOST" ] || exit 3\ncase "$3 $4" in\n  "--hostname github.com") printf '${token}\\n';;\n  " "|"--hostname enterprise.example.test") printf '${enterpriseToken}\\n';;\n  *) exit 4;;\nesac\n`,
          { mode: 0o700 },
        );
        const authEnv = await buildAuthEnvironment(options);
        expect(await ghAuthToken(authEnv, { hostname: "enterprise.example.test" })).toBe(
          enterpriseToken,
        );
        if (consumer === "seat") {
          fake.createSession.mockResolvedValueOnce({ disconnect: vi.fn() });
          fake.list.mockResolvedValueOnce({ models: [{ id: "seat-model" }] });
          expect(await probeCopilotSeat(options)).toEqual({
            kind: "seat-ok",
            models: ["seat-model"],
          });
        } else {
          const runtime = new CopilotRuntime(options);
          try {
            await runtime.listModels();
          } finally {
            await runtime.stop();
          }
        }
        expect(fake.configs[0]?.gitHubToken).toBe(token);
        expect(fake.list).toHaveBeenLastCalledWith({ gitHubToken: token });
        for (const secret of [token, enterpriseToken]) {
          expect(inspect(authEnv)).not.toContain(secret);
          expect(inspect(fake.configs[0]?.env)).not.toContain(secret);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it.skipIf(process.platform === "win32")(
    "falls back to the login-shell gh when the managed current pointer is a regular file",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "spicode-torn-gh-"));
      const appDataDir = join(root, "app");
      const shellBin = join(root, "shell-bin");
      const token = "gho_obviouslyFakeLoginShellFallback";
      const logs = ["log", "info", "warn", "error", "debug"] as const;
      const spies = logs.map((name) => vi.spyOn(console, name).mockImplementation(() => {}));
      try {
        const managed = join(appDataDir, "tools", "gh");
        await mkdir(join(managed, "2.83.0", "bin"), { recursive: true });
        await writeFile(join(managed, "2.83.0", "bin", "gh"), "#!/bin/sh\nexit 9\n", {
          mode: 0o700,
        });
        await writeFile(join(managed, "current"), "2.83.0");
        await mkdir(shellBin);
        await writeFile(
          join(shellBin, "gh"),
          `#!/bin/sh\n[ "$1 $2" = "auth token" ] || exit 2\nprintf '${token}\\n'\n`,
          { mode: 0o700 },
        );
        const options = {
          appDataDir,
          capturedPath: shellBin,
          installer: await createToolInstaller(appDataDir, "darwin-arm64"),
        };
        expect(await options.installer.binDir("gh")).toBeUndefined();
        expect((await buildAuthEnvironment(options)).PATH).toBe(shellBin);
        const runtime = new CopilotRuntime(options);
        try {
          await runtime.start();
        } finally {
          await runtime.stop();
        }
        expect(fake.configs[0]?.gitHubToken).toBe(token);
        expect(inspect(fake.configs[0]?.env)).not.toContain(token);
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      } finally {
        for (const spy of spies) spy.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["", "dummy\0secret", "dummy secret", "dummy\nsecret", "dummy\u007fsecret"])(
    "rejects malformed credentials before SDK construction without echoing them",
    async (token) => {
      const runtime = new CopilotRuntime(
        { appDataDir: "/tmp/spicode", capturedPath: "/bin" },
        async () => token,
      );
      await expect(runtime.start()).rejects.toThrow("Invalid GitHub credential");
      expect(fake.construct).not.toHaveBeenCalled();
      for (const action of [() => runtime.listModels(), () => runtime.createSession()]) {
        await expect(action()).rejects.toThrow("Invalid GitHub credential");
      }
      expect(fake.configs).toEqual([]);
    },
  );

  it("passes only the scrubbed environment to gh behind the default token reader", async () => {
    const ghRunner = vi.fn().mockResolvedValue("dummy-valid-secret");
    const bin = join("/tmp/spicode", "tools", "gh", "2.83.0", "bin");
    const installer = { binDir: vi.fn().mockResolvedValue(bin) };
    const runtime = new CopilotRuntime(
      {
        appDataDir: "/tmp/spicode",
        capturedPath: "/bin",
        installer,
        env: {
          GH_TOKEN: "stray",
          gh_token: "stray",
          Gh_ToKeN: "stray",
          GITHUB_TOKEN: "stray",
          github_token: "stray",
          COPILOT_GITHUB_TOKEN: "stray",
          Copilot_Github_Token: "stray",
        },
      },
      undefined,
      stubToolSource,
      ghRunner,
    );
    await runtime.start();
    await runtime.listModels();
    await expect(runtime.createSession()).rejects.toThrow("session stub");
    expect(ghRunner).toHaveBeenCalledTimes(3);
    expect(installer.binDir).toHaveBeenCalledTimes(6);
    expect(installer.binDir).toHaveBeenCalledWith("gh");
    expect(installer.binDir).toHaveBeenCalledWith("glab");
    expect(fake.configs[0]?.env?.PATH?.split(delimiter)).toEqual([bin, "/bin"]);
    for (const [env, options] of ghRunner.mock.calls) {
      expect(options).toEqual({ hostname: "github.com", timeoutMs: 5000 });
      expect(env.PATH?.split(delimiter)).toEqual([bin, "/bin"]);
      expect(Object.keys(env).map((key) => key.toUpperCase())).not.toEqual(
        expect.arrayContaining(["GH_TOKEN"]),
      );
      for (const key of Object.keys(env)) {
        expect(["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN"]).not.toContain(
          key.toUpperCase(),
        );
      }
    }
    await runtime.stop();
  });

  it.each(["start", "listModels", "createSession"] as const)(
    "%s resolves the managed gh path once per operation and refreshes it after restart",
    async (operation) => {
      const firstBin = join("/tmp/spicode", "tools", "gh", "first", "bin");
      const secondBin = join("/tmp/spicode", "tools", "gh", "second", "bin");
      const ghBins = [firstBin, secondBin, firstBin];
      const installer = {
        binDir: vi.fn(async (tool: string) => (tool === "gh" ? ghBins.shift() : undefined)),
      };
      const ghRunner = vi
        .fn()
        .mockResolvedValueOnce("first-fixture")
        .mockResolvedValueOnce("second-fixture")
        .mockResolvedValueOnce("first-fixture");
      fake.createSession.mockResolvedValue({});
      const runtime = new CopilotRuntime(
        {
          appDataDir: "/tmp/spicode",
          capturedPath: "/bin",
          installer,
          env: { HOME: "/operator", GH_TOKEN: "stray" },
        },
        undefined,
        stubToolSource,
        ghRunner,
      );
      try {
        for (const [index, bin] of [firstBin, secondBin, firstBin].entries()) {
          if (index === 2) await runtime.stop();
          await runtime[operation]();
          expect(installer.binDir).toHaveBeenCalledTimes((index + 1) * 2);
          expect(installer.binDir).toHaveBeenNthCalledWith(index * 2 + 1, "gh");
          expect(installer.binDir).toHaveBeenLastCalledWith("glab");
          expect(ghRunner.mock.calls[index]?.[0]).toMatchObject({
            PATH: [bin, "/bin"].join(delimiter),
            HOME: "/operator",
          });
          expect(fake.configs[index]?.env?.PATH).toBe([bin, "/bin"].join(delimiter));
          expect(fake.configs[index]?.env?.HOME).not.toBe("/operator");
          expect(fake.configs[index]?.gitHubToken).toBe(
            index === 1 ? "second-fixture" : "first-fixture",
          );
        }
      } finally {
        await runtime.stop();
      }
    },
  );

  it.each(["construct", "start", "list", "session", "stream"] as const)(
    "recursively redacts credential-bearing %s errors and keeps originals private",
    async (phase) => {
      const token = "dummy-secret-token";
      const leaf = new Error(`leaf ${token}`, { cause: { message: token, stack: token } });
      const original = new AggregateError(
        [leaf, { cause: new Error(token) }, token],
        `aggregate ${token}`,
        { cause: new Error(token) },
      );
      const fail = () => {
        throw original;
      };
      const session = {
        on: vi.fn().mockReturnValue(vi.fn()),
        sendAndWait: vi.fn().mockRejectedValue(original),
      };
      const runtime = new CopilotRuntime(
        { appDataDir: "/tmp/spicode", capturedPath: "/bin" },
        async () => token,
      );
      let action: () => Promise<unknown>;
      if (phase === "construct") {
        fake.construct.mockImplementationOnce(fail);
        action = () => runtime.start();
      } else if (phase === "start") {
        fake.start.mockRejectedValueOnce(original);
        fake.stop.mockResolvedValueOnce([leaf]);
        action = () => runtime.start();
      } else {
        await runtime.start();
        if (phase === "list") {
          fake.list.mockRejectedValueOnce(original);
          action = () => runtime.listModels();
        } else if (phase === "session") {
          fake.createSession.mockRejectedValueOnce(original);
          action = () => runtime.createSession();
        } else {
          fake.createSession.mockResolvedValueOnce(session);
          const opened = await runtime.createSession();
          action = () => streamTurn(opened, "hello", () => {});
        }
      }
      const result = await action().then(
        () => {
          throw new Error("Expected a failure.");
        },
        (error: unknown) => error,
      );
      expect(result).toBeInstanceOf(AggregateError);
      expect(inspect(result, { depth: null })).not.toContain(token);
      expect(inspect(result, { depth: null })).toContain("[redacted]");
      expect(original.message).toContain(token);
      expect(leaf.message).toContain(token);
      await runtime.stop();
    },
  );
  it("bounds runtime credentials while retaining an old session's redaction snapshot", async () => {
    const session = {
      on: vi.fn().mockReturnValue(vi.fn()),
      sendAndWait: vi.fn().mockRejectedValue(new Error("failed with first-secret")),
    };
    fake.createSession.mockResolvedValueOnce(session);
    const readToken = vi
      .fn()
      .mockResolvedValueOnce("first-secret")
      .mockResolvedValueOnce("second-secret")
      .mockResolvedValueOnce("third-secret");
    const runtime = new CopilotRuntime(
      { appDataDir: "/tmp/spicode", capturedPath: "/bin" },
      readToken,
    );
    const opened = await runtime.createSession();
    await runtime.listModels();
    await runtime.listModels();
    expect(Reflect.get(runtime, "tokens")).toEqual(new Set(["second-secret", "third-secret"]));
    await expect(streamTurn(opened, "hello", () => {})).rejects.toThrow("failed with [redacted]");
    await runtime.stop();
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

  it("isolates every runtime home without mutating the caller or process environment", () => {
    const before = { ...process.env };
    const names = [
      "HOME",
      "USERPROFILE",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_STATE_HOME",
      "XDG_DATA_HOME",
      "LOCALAPPDATA",
      "APPDATA",
      "COPILOT_HOME",
    ];
    const env = Object.fromEntries(
      [...names, "HOMEDRIVE", "HOMEPATH", "HomeDrive", "HomePath"].flatMap((name) => [
        [name, "/operator"],
        [name.toLowerCase(), "/operator-lowercase"],
      ]),
    );
    const original = { ...env };
    const appDataDir = join(tmpdir(), "spicode-app");
    const options = buildClientOptions({
      appDataDir,
      capturedPath: "/bin",
      env,
    });
    for (const name of names) {
      const path = options.env?.[name];
      expect(path).toBeDefined();
      expect(isAbsolute(path ?? "")).toBe(true);
      expect(relative(appDataDir, path ?? "").startsWith("..")).toBe(false);
      expect(options.env).not.toHaveProperty(name.toLowerCase());
    }
    expect(Object.keys(options.env ?? {}).map((name) => name.toUpperCase())).not.toEqual(
      expect.arrayContaining(["HOMEDRIVE"]),
    );
    expect(Object.keys(options.env ?? {}).map((name) => name.toUpperCase())).not.toEqual(
      expect.arrayContaining(["HOMEPATH"]),
    );
    expect(env).toEqual(original);
    expect(process.env).toEqual(before);
  });

  it.skipIf(process.platform === "win32").each(["runtime", "seat"])(
    "%s reads the default credential through a fake gh with the real home and config",
    async (consumer) => {
      const root = await mkdtemp(join(tmpdir(), "spicode-gh-home-"));
      const home = join(root, "operator");
      const config = join(root, "operator-config");
      const appDataDir = join(root, "app-data");
      try {
        await mkdir(home);
        await mkdir(config);
        await writeFile(join(home, "token"), "home-token");
        await writeFile(join(config, "token"), "config-token");
        await writeFile(
          join(root, "gh"),
          '#!/bin/sh\n[ "$1 $2" = "auth token" ] || exit 1\n[ "$(cat "$HOME/token")" = "home-token" ] || exit 2\ncat "$XDG_CONFIG_HOME/token"\n',
          { mode: 0o700 },
        );
        const options = {
          appDataDir,
          capturedPath: [root, "/usr/bin", "/bin"].join(delimiter),
          env: { ...process.env, HOME: home, XDG_CONFIG_HOME: config, GH_TOKEN: "stray" },
          installer: await createToolInstaller(appDataDir, "darwin-arm64"),
        };
        expect(await options.installer.binDir("gh")).toBeUndefined();
        if (consumer === "seat") {
          fake.createSession.mockResolvedValueOnce({ disconnect: vi.fn() });
          fake.list.mockResolvedValueOnce({ models: [{ id: "seat-model" }] });
          expect(await probeCopilotSeat(options)).toEqual({
            kind: "seat-ok",
            models: ["seat-model"],
          });
        } else {
          const runtime = new CopilotRuntime(options);
          try {
            await runtime.start();
          } finally {
            await runtime.stop();
          }
        }
        expect(fake.configs[0]?.gitHubToken).toBe("config-token");
        expect(fake.configs[0]?.env?.HOME).not.toBe(home);
        expect(fake.configs[0]?.env?.XDG_CONFIG_HOME).not.toBe(config);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

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
