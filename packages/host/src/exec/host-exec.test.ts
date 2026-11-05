// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ToolInstaller } from "@spi-code/tools";
import { afterEach, expect, it, vi } from "vitest";
import { createManagedToolEnvironment } from "../env/tool-environment.js";
import { HostExec } from "./host-exec.js";

// Real processes start slowly when the machine is busy; waitFor defaults to 1s.
const PROCESS_WAIT = { timeout: 15_000 };

// Polls on the real clock: vi.waitFor would advance fake timers and fire the exec timeout early.
async function waitForPid(file: string): Promise<number> {
  const deadline = Date.now() + PROCESS_WAIT.timeout;
  while (Date.now() < deadline) {
    try {
      const pid = Number(await readFile(file, "utf8"));
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    await delay(10);
  }
  throw new Error("Child did not report readiness.");
}

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const appData = await mkdtemp(join(tmpdir(), "spi-exec-"));
  directories.push(appData);
  return {
    appData,
    capturedPath: process.env.PATH ?? "",
    installer: { binDir: async () => undefined },
  };
}

it("delivers redacted device progress before exit, retaining the buffered stdout", async () => {
  const options = await fixture();
  const controller = new AbortController();
  let release = (_text: string) => {};
  const progress = new Promise<string>((resolve) => {
    release = resolve;
  });
  const chunks: string[] = [];
  let completed = false;
  const run = new HostExec(options)
    .runText(
      process.execPath,
      [
        "-e",
        "process.stdout.write('payload'); process.stderr.write('gh'); setTimeout(() => process.stderr.write('p_planted ABCD-1234 https://github.com/login/device\\n'), 30); setInterval(() => {}, 1000)",
      ],
      {
        signal: controller.signal,
        timeoutMs: 20_000,
        onOutput: (stream, text) => {
          chunks.push(text);
          if (stream === "stderr") release(text);
        },
      },
    )
    .then((result) => {
      completed = true;
      return result;
    });
  try {
    expect(await progress).toBe("<redacted> ABCD-1234 https://github.com/login/device\n");
    expect(completed).toBe(false);
    expect(chunks).toContain("payload");
    expect(chunks.join("")).not.toContain("ghp_planted");
  } finally {
    controller.abort();
  }
  expect(await run).toMatchObject({ ok: false, error: "Command aborted." });
  expect(chunks).toContain("payload");
  const output = await new HostExec(options).run(process.execPath, [
    "-e",
    "process.stdout.write('unchanged')",
  ]);
  expect(output.stdout).toBe("unchanged");
}, 25_000);

it("never exposes an echoed opaque stdin token through chunks, logs or errors", async () => {
  const options = await fixture();
  const logs: unknown[] = [];
  const chunks: string[] = [];
  const token = "opaque.credential";
  const exec = new HostExec({ ...options, log: (entry) => logs.push(entry) });
  const result = await exec.runText(
    process.execPath,
    [
      "-e",
      "process.stdin.on('data', x => process.stderr.write(x)); process.stdin.on('end', () => { process.exitCode = 1; })",
    ],
    { stdin: `${token}\n`, onOutput: (_stream, text) => chunks.push(text) },
  );
  const missing = await exec.runText(join(options.appData, token), [], { stdin: token });
  const invalidJSON = await exec.runJSON(
    process.execPath,
    ["-e", "process.stdin.on('data', x => process.stdout.write('{'+x))"],
    { stdin: token },
  );
  expect(result).toMatchObject({ ok: false, error: "<redacted>" });
  expect(missing.ok).toBe(false);
  expect(invalidJSON.ok).toBe(false);
  expect(JSON.stringify({ result, missing, invalidJSON, logs, chunks })).not.toContain(token);
  expect(chunks).toEqual(["<redacted>\n"]);
});

it("terminates a running child on abort and does not spawn for a pre-aborted signal", async () => {
  const options = await fixture();
  const pidFile = join(options.appData, "abort-pid");
  const controller = new AbortController();
  const exec = new HostExec(options);
  const run = exec.runText(
    process.execPath,
    [
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
    ],
    { signal: controller.signal, timeoutMs: 20_000 },
  );
  let pid = 0;
  try {
    pid = await waitForPid(pidFile);
  } finally {
    controller.abort("opaque.abort-reason");
  }
  expect(await run).toMatchObject({ ok: false, error: "Command aborted." });
  expect(() => process.kill(pid, 0)).toThrow();
  expect(
    await exec.runText("nonexistent-command", [], {
      signal: AbortSignal.abort("opaque.abort-reason"),
    }),
  ).toEqual({ ok: false, error: "Command aborted.", code: null });
}, 25_000);

it.skipIf(process.platform === "win32")("runs managed gh before login PATH gh", async () => {
  const options = await fixture();
  const root = join(options.appData, "tools", "gh");
  const bin = join(root, "1.0.0", "bin");
  const login = join(options.appData, "login");
  await Promise.all([mkdir(bin, { recursive: true }), mkdir(login)]);
  await writeFile(join(bin, "gh"), "#!/bin/sh\nprintf managed", { mode: 0o755 });
  await writeFile(join(login, "gh"), "#!/bin/sh\nprintf login", { mode: 0o755 });
  await symlink("1.0.0", join(root, "current"));
  const platforms = {
    "darwin-arm64": { url: "https://example.com/tool.zip", sha256: "a".repeat(64) },
    "win32-x64": { url: "https://example.com/tool.zip", sha256: "a".repeat(64) },
  };
  const installer = new ToolInstaller(
    options.appData,
    {
      tools: ["gh", "glab"].map((tool) => ({ tool, version: "1.0.0", platforms })),
    },
    "darwin-arm64",
  );
  const exec = new HostExec({ ...options, installer, capturedPath: login });
  expect(await exec.runText("gh", ["--version"])).toEqual({
    ok: true,
    data: "managed",
    exitCode: 0,
  });
  const env = await createManagedToolEnvironment({ ...options, installer, capturedPath: login });
  expect(env.PATH).toBe(`${bin}:${login}`);
});

it("owns configuration dirs and scrubs overrides, keeping only the named token", async () => {
  const options = await fixture();
  const env = {
    GH_TOKEN: "first-secret",
    GITHUB_TOKEN: "second-secret",
    COPILOT_GITHUB_TOKEN: "copilot-secret",
    SPI_SKIP_GUARD: "yes",
    GH_HOST: "untrusted",
    KUBECONFIG: "foreign",
    AZURE_CONFIG_DIR: "foreign",
  };
  const plain = await createManagedToolEnvironment({ ...options, env });
  expect(plain.GH_TOKEN).toBeUndefined();
  expect(plain.GITHUB_TOKEN).toBeUndefined();
  expect(plain.COPILOT_GITHUB_TOKEN).toBeUndefined();
  expect(plain.SPI_SKIP_GUARD).toBeUndefined();
  expect(plain.GH_HOST).toBeUndefined();
  expect(plain.KUBECONFIG).toBe(join(options.appData, "kube", "config"));
  expect(plain.AZURE_CONFIG_DIR).toBe(join(options.appData, "azure"));
  const kept = await createManagedToolEnvironment({ ...options, env, keepToken: "GITHUB_TOKEN" });
  expect(kept.GITHUB_TOKEN).toBe("second-secret");
  expect(kept.GH_TOKEN).toBeUndefined();
  const windows = await createManagedToolEnvironment({
    ...options,
    env: { github_token: "second-secret", Path: "foreign" },
    platform: "win32",
    capturedPath: "C:\\login",
    keepToken: "GITHUB_TOKEN",
    installer: { binDir: async (tool) => `C:\\${tool}` },
  });
  expect(windows.PATH).toBe("C:\\gh;C:\\glab;C:\\login");
  expect(windows.GITHUB_TOKEN).toBe("second-secret");
  expect(windows.Path).toBeUndefined();
});

it("passes stdin, cwd and env, parses JSON and accepts a nonzero result only on request", async () => {
  const options = await fixture();
  const exec = new HostExec(options);
  // The child reports its cwd as given, so pass the canonical path: /private/var on macOS,
  // and the long name on Windows, where the temporary directory is an 8.3 short name.
  const cwd = await realpath(options.appData);
  const args = [
    "-e",
    "process.stdin.on('data', x => process.stdout.write(JSON.stringify({input: x.toString(), cwd: process.cwd(), value: process.env.VALUE})))",
  ];
  expect(
    await exec.runJSON(process.execPath, args, {
      stdin: "hello",
      cwd,
      env: { VALUE: "test" },
    }),
  ).toEqual({
    ok: true,
    data: { input: "hello", cwd, value: "test" },
    exitCode: 0,
  });
  const failure = [
    "-e",
    "process.stderr.write('failed'); process.stdout.write('payload'); process.exitCode = 7",
  ];
  expect(await exec.runText(process.execPath, failure)).toEqual({
    ok: false,
    error: "failed",
    code: 7,
  });
  expect(await exec.runText(process.execPath, failure, { acceptNonZeroExit: true })).toEqual({
    ok: true,
    data: "payload",
    exitCode: 7,
    stderr: "failed",
  });
});

it("redacts argv, stderr and spawn errors before the host log", async () => {
  const options = await fixture();
  const logs: unknown[] = [];
  const exec = new HostExec({
    ...options,
    env: { GH_TOKEN: "opaque-token-secret" },
    log: (entry) => logs.push(entry),
  });
  const token = "ghp_fixture_secret";
  await exec.runText(process.execPath, [
    "-e",
    "process.stderr.write(process.argv[1] + process.argv[2]); process.exitCode=1",
    token,
    "opaque-token-secret",
  ]);
  const missing = await exec.runText(join(options.appData, token), []);
  expect(missing.ok).toBe(false);
  const text = JSON.stringify(logs);
  expect(text).not.toContain(token);
  expect(text).not.toContain("opaque-token-secret");
  expect(text).toContain("<redacted>");
  expect(logs).toHaveLength(2);
});

it("kills the entire hung process tree including a SIGTERM-ignoring grandchild", async () => {
  const options = await fixture();
  const pidFile = join(options.appData, "pid");
  const grandchild = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
  const parent = `process.on('SIGTERM', () => {}); require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio: 'inherit'}); setInterval(() => {}, 1000)`;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const result = new HostExec(options).runText(process.execPath, ["-e", parent], {
    timeoutMs: 1000,
  });
  let pid = 0;
  try {
    pid = await waitForPid(pidFile);
    if (process.platform !== "win32") process.kill(pid, "SIGTERM");
    process.kill(pid, 0);
  } finally {
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(await result).toMatchObject({ ok: false, error: "Command timed out after 1000ms." });
  vi.useRealTimers();
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), PROCESS_WAIT);
});

it.skipIf(process.platform === "win32")(
  "returns at timeout while a detached descendant still holds the pipes",
  async () => {
    const options = await fixture();
    const pidFile = join(options.appData, "pid");
    const holder = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 20000)`;
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(holder)}], {stdio: 'inherit', detached: true}); setInterval(() => {}, 1000)`;
    const started = Date.now();
    const result = await new HostExec(options).runText(process.execPath, ["-e", parent], {
      timeoutMs: 500,
    });
    try {
      expect(result).toMatchObject({ ok: false, error: "Command timed out after 500ms." });
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      const pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
      if (pid > 0) process.kill(pid, "SIGKILL");
    }
  },
  10_000,
);
