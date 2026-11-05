// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildToolEnvironment,
  captureLoginShellPath,
  ghAuthToken,
  parseLoginShellPath,
} from "./shell-environment.js";

const start = "__SPICODE_ENV_PATH_START__";
const end = "__SPICODE_ENV_PATH_END__";
const secret = "sensitive-env-fixture";
const directories: string[] = [];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "spi-code-env-"));
  directories.push(directory);
  return directory;
}

async function script(directory: string, name: string, body: string) {
  const file = join(directory, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  return file;
}

function toolEnvironment(capturedPath: string, env = process.env) {
  return buildToolEnvironment({
    platform: "linux",
    toolsDir: join(tmpdir(), "spi-code-app-tools"),
    capturedPath,
    kubeconfig: join(tmpdir(), "spi-code-app-config", "kubeconfig"),
    azureConfigDir: join(tmpdir(), "spi-code-app-config", "azure"),
    env,
  });
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("login-shell PATH", () => {
  it("parses markers amid startup chatter and CRLF", () => {
    expect(parseLoginShellPath(`banner\r\n${start}\r\n/opt/bin:/usr/bin\r\n${end}\r\nbye`)).toBe(
      "/opt/bin:/usr/bin",
    );
    expect(parseLoginShellPath(`prefix${start}\n/opt/bin\n${end}suffix`)).toBe("/opt/bin");
    expect(parseLoginShellPath(`prefix${start}/opt/bin${end}suffix`)).toBe("/opt/bin");
    for (const output of [
      "/opt/bin",
      `${start}\n/opt/bin`,
      `${start}\n\n${end}`,
      `${start}\n/opt/bin\nnoise\n${end}`,
      `${start}\n/opt/bin\0\n${end}`,
    ]) {
      expect(parseLoginShellPath(output)).toBeUndefined();
    }
  });

  it.each(["PATH", "Path", "path", "pAtH"])(
    "uses Windows %s without running a shell",
    async (name) => {
      expect(
        await captureLoginShellPath({
          platform: "win32",
          env: { [name]: "C:\\Windows;C:\\Tools" },
          shells: ["/does/not/exist"],
        }),
      ).toEqual({ path: "C:\\Windows;C:\\Tools", captured: false, failures: [] });
    },
  );

  it.skipIf(process.platform === "win32")("falls back on garbage and spawn failure", async () => {
    const directory = await fixture();
    const shell = await script(directory, "shell", "printf 'startup garbage'");
    const result = await captureLoginShellPath({
      platform: "linux",
      env: { PATH: "/usr/bin:/bin" },
      shells: ["/does/not/exist", shell],
    });
    expect(result).toEqual({
      path: "/usr/bin:/bin",
      captured: false,
      failures: ["failed", "invalid-output"],
    });
  });

  it.skipIf(process.platform === "win32")(
    "scrubs tokens and guard bypasses before shell capture",
    async () => {
      for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "SPI_SKIP_GUARD"]) {
        vi.stubEnv(name, secret);
      }
      const directory = await fixture();
      const shell = await script(
        directory,
        "shell",
        [
          'test -z "$GH_TOKEN$GITHUB_TOKEN$COPILOT_GITHUB_TOKEN$SPI_SKIP_GUARD" || exit 2',
          `printf '%s\\n' '${start}' '/captured/bin' '${end}'`,
        ].join("\n"),
      );
      const result = await captureLoginShellPath({ shells: [shell] });
      expect(result.captured).toBe(true);
      expect(result.path.split(":")[0]).toBe("/captured/bin");
      expect(result.failures).toEqual([]);
      expect(process.env.GH_TOKEN === secret).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "kills an uncooperative shell on timeout and falls back",
    async () => {
      const directory = await fixture();
      const pidFile = join(directory, "pid");
      const shell = await script(
        directory,
        "shell",
        [`printf '%s' "$$" > '${pidFile}'`, "trap '' TERM", "while :; do :; done"].join("\n"),
      );
      const result = await captureLoginShellPath({
        platform: "linux",
        shells: [shell],
        timeoutMs: 150,
        env: { PATH: "/usr/bin:/bin" },
      });
      expect(result).toEqual({ path: "/usr/bin:/bin", captured: false, failures: ["timeout"] });
      const pid = Number(await readFile(pidFile, "utf8"));
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    },
  );
});

describe("tool environment", () => {
  it("scrubs inherited credentials and guard bypasses without mutating process.env", () => {
    for (const name of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "COPILOT_GITHUB_TOKEN",
      "SPI_SKIP_GUARD",
      "SPI_BYPASS_GUARD",
      "OTHER_DISABLE_GUARD",
      "SPI_GUARD_BYPASS",
    ]) {
      vi.stubEnv(name, secret);
    }
    const env = toolEnvironment("/captured/bin:/usr/bin");
    expect(Object.values(env).includes(secret)).toBe(false);
    expect(env.PATH).toBe(`${join(tmpdir(), "spi-code-app-tools")}:/captured/bin:/usr/bin`);
    expect(env.KUBECONFIG).toBe(join(tmpdir(), "spi-code-app-config", "kubeconfig"));
    expect(env.AZURE_CONFIG_DIR).toBe(join(tmpdir(), "spi-code-app-config", "azure"));
    expect(process.env.GH_TOKEN === secret).toBe(true);
  });

  it("normalizes Windows names and PATH while removing case-variant secrets", () => {
    const env = buildToolEnvironment({
      platform: "win32",
      toolsDir: "C:\\App\\tools",
      capturedPath: 'C:\\TOOLS;"C:\\App\\tools";C:\\Windows',
      kubeconfig: "C:\\App\\kubeconfig",
      azureConfigDir: "C:\\App\\azure",
      env: { Path: "old", gh_token: secret, Spi_Skip_Guard: secret, azure_config_dir: "old" },
    });
    expect(env).toEqual({
      PATH: "C:\\App\\tools;C:\\TOOLS;C:\\Windows",
      KUBECONFIG: "C:\\App\\kubeconfig",
      AZURE_CONFIG_DIR: "C:\\App\\azure",
    });
  });

  it("only admits tokens explicitly named in Settings", () => {
    const env = buildToolEnvironment({
      platform: "linux",
      toolsDir: "/app/tools",
      capturedPath: "/usr/bin",
      kubeconfig: "/app/kubeconfig",
      azureConfigDir: "/app/azure",
      env: { GH_TOKEN: secret, GITHUB_TOKEN: secret },
      configuredTokens: { GITHUB_TOKEN: "configured-fixture" },
    });
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBe("configured-fixture");
  });
});

describe.skipIf(process.platform === "win32")("gh auth token", () => {
  it("defensively strips caller guard bypasses while preserving configured tokens", async () => {
    const directory = await fixture();
    await script(
      directory,
      "gh",
      [
        'test -z "$SPI_SKIP_GUARD$SPI_BYPASS_GUARD$OTHER_DISABLE_GUARD$SPI_GUARD_BYPASS" || exit 2',
        `test "$GH_TOKEN" = '${secret}' || exit 3`,
        `test "$GITHUB_TOKEN" = '${secret}' || exit 4`,
        "printf 'oauth-fixture\\n'",
      ].join("\n"),
    );
    const env = toolEnvironment(directory);
    for (const name of [
      "SPI_SKIP_GUARD",
      "SPI_BYPASS_GUARD",
      "OTHER_DISABLE_GUARD",
      "SPI_GUARD_BYPASS",
      "GH_TOKEN",
      "GITHUB_TOKEN",
    ]) {
      env[name] = secret;
    }
    expect(await ghAuthToken(env)).toBe("oauth-fixture");
    expect(env.SPI_SKIP_GUARD === secret).toBe(true);
  });

  it("finds gh only on the captured PATH and returns its stdout with no inherited tokens", async () => {
    const directory = await fixture();
    const logs = ["log", "info", "warn", "error", "debug"] as const;
    const spies = logs.map((name) => vi.spyOn(console, name).mockImplementation(() => {}));
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "SPI_SKIP_GUARD"]) {
      vi.stubEnv(name, secret);
    }
    await script(
      directory,
      "gh",
      [
        'test "$1 $2" = "auth token" || exit 2',
        'test -z "$GH_TOKEN$GITHUB_TOKEN$COPILOT_GITHUB_TOKEN$SPI_SKIP_GUARD" || exit 3',
        "printf 'oauth-fixture\\n'",
      ].join("\n"),
    );
    expect((process.env.PATH ?? "").split(":").includes(directory)).toBe(false);
    const shell = await script(
      directory,
      "shell",
      [
        'test "$1" = "-ilc" || exit 2',
        `export PATH='${directory}:/usr/bin:/bin'`,
        'exec /bin/sh -c "$2"',
      ].join("\n"),
    );
    const capture = await captureLoginShellPath({ shells: [shell] });
    expect(capture.captured).toBe(true);
    expect(await ghAuthToken(toolEnvironment(capture.path))).toBe("oauth-fixture");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("never exposes failed stdout, stderr or configured tokens in errors or logs", async () => {
    const directory = await fixture();
    await script(directory, "gh", `printf '${secret}'; printf '${secret}' >&2; exit 1`);
    const logs = ["log", "info", "warn", "error", "debug"] as const;
    const spies = logs.map((name) => vi.spyOn(console, name).mockImplementation(() => {}));
    const env = toolEnvironment(directory);
    env.GH_TOKEN = secret;
    const error = await ghAuthToken(env).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(inspect(error).includes(secret)).toBe(false);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("rejects missing gh and empty tokens with sanitized errors", async () => {
    const directory = await fixture();
    await expect(ghAuthToken(toolEnvironment(directory))).rejects.toThrow("gh auth token failed.");
    await script(directory, "gh", "printf '\\n'");
    await expect(ghAuthToken(toolEnvironment(directory))).rejects.toThrow(
      "gh auth token returned no token.",
    );
  });

  it("sanitizes synchronous spawn errors containing an invalid configured token", async () => {
    const directory = await fixture();
    const env = toolEnvironment(directory);
    env.GH_TOKEN = `${secret}\0`;
    const error = await ghAuthToken(env).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(inspect(error).includes(secret)).toBe(false);
  });

  it("kills gh on timeout even if it ignores SIGTERM", async () => {
    const directory = await fixture();
    const pidFile = join(directory, "pid");
    await script(
      directory,
      "gh",
      [
        `printf '%s' "$$" > '${pidFile}'`,
        `printf '${secret}'`,
        "trap '' TERM",
        "while :; do :; done",
      ].join("\n"),
    );
    await expect(ghAuthToken(toolEnvironment(directory), { timeoutMs: 150 })).rejects.toThrow(
      "gh auth token timed out.",
    );
    const pid = Number(await readFile(pidFile, "utf8"));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  });
});
