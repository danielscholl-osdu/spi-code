// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { type ExecOptions, RecordingExec } from "@spi-code/core";
import { ToolInstaller } from "@spi-code/tools";
import { afterEach, expect, it, vi } from "vitest";
import { createManagedToolEnvironment } from "../env/tool-environment.js";
import { HostExec, type HostExecLog } from "./host-exec.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
  };
});

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
  vi.mocked(spawn).mockReset();
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
  // A host *TOKEN* value that starts like the tail of the payload would hold that byte back.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/TOKEN/i.test(name)),
  );
  const options = { ...(await fixture()), env };
  const controller = new AbortController();
  const progress = "<redacted> ABCD-1234 https://github.com/login/device\n";
  let release = () => {};
  const received = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chunks: ["stdout" | "stderr", string][] = [];
  const joined = (stream: "stdout" | "stderr") =>
    chunks
      .filter(([from]) => from === stream)
      .map(([, text]) => text)
      .join("");
  let completed = false;
  // Every byte is its own write, a tick apart, so a chunk can end at any boundary.
  const child = `
    const bytes = (fd, text) => new Promise((done) => {
      let i = 0;
      const next = () => {
        if (i === text.length) return done();
        (fd === 1 ? process.stdout : process.stderr).write(text[i++]);
        setTimeout(next, 10);
      };
      next();
    });
    bytes(1, 'payload')
      .then(() => bytes(2, 'ghp_planted ABCD-1234 https://github.com/login/device\\n'))
      .then(() => setInterval(() => {}, 1000));
  `;
  const run = new HostExec(options)
    .runText(process.execPath, ["-e", child], {
      signal: controller.signal,
      timeoutMs: 20_000,
      onOutput: (stream, text) => {
        chunks.push([stream, text]);
        if (joined("stderr").endsWith("\n")) release();
      },
    })
    .then((result) => {
      completed = true;
      return result;
    });
  try {
    await received;
    expect(joined("stderr")).toBe(progress);
    await vi.waitFor(() => expect(joined("stdout")).toBe("payload"), PROCESS_WAIT);
    expect(completed).toBe(false);
  } finally {
    controller.abort();
  }
  expect(await run).toMatchObject({ ok: false, error: "Command aborted." });
  expect(joined("stdout")).toBe("payload");
  expect(joined("stderr")).toBe(progress);
  expect(chunks.map(([, text]) => text).join("")).not.toMatch(/ghp_|planted/);
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

it.each([
  ["HostExec", "payload", "dummyvalue1234567890", "payloa", "payload"],
  ["HostExec", "done", "done-not-a-real-token", "", "<redacted>"],
  ["HostExec", "dummyvalue1234", "dummyvalue1234567890", "", "<redacted>"],
  ["RecordingExec-over-HostExec", "payload", "dummyvalue1234567890", "payloa", "payload"],
  [
    "RecordingExec-over-HostExec",
    "payloadone",
    "done-not-a-real-token",
    "payloa",
    "payloa<redacted>",
  ],
])(
  "%s cancellation preserves the terminal text for %j without double buffering or resuming live output",
  async (runner, text, token, live, terminal) => {
    const options = await fixture();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/TOKEN/i.test(name)),
    );
    const controller = new AbortController();
    const chunks = { stdout: [] as string[], stderr: [] as string[] };
    const child = `
      const text = 'useful output\\n' + ${JSON.stringify(text)};
      let i = 0;
      const next = () => {
        if (i === text.length) {
          process.stderr.write('ready!\\n');
          return setInterval(() => process.stdout.write('late output'), 1000);
        }
        process.stdout.write(text[i++]);
        setTimeout(next, 10);
      };
      next();
    `;
    const host = new HostExec({ ...options, env });
    const exec = runner === "HostExec" ? host : new RecordingExec(host.run, () => {});
    const run = exec.runText(process.execPath, ["-e", child], {
      env: { REVIEW_TOKEN: token },
      signal: controller.signal,
      timeoutMs: 20_000,
      onOutput: (stream, chunk) => chunks[stream].push(chunk),
    });
    try {
      await vi.waitFor(() => expect(chunks.stderr.join("")).toBe("ready!\n"), PROCESS_WAIT);
      expect(chunks.stdout.join("")).toBe(`useful output\n${live}`);
      const count = chunks.stdout.length;
      controller.abort();
      expect(await run).toMatchObject({ ok: false, error: "Command aborted." });
      expect(chunks.stdout.join("")).toBe(`useful output\n${terminal}`);
      expect(chunks.stdout).toHaveLength(count + 1);
      const snapshot = JSON.stringify(chunks);
      await delay(25);
      expect(JSON.stringify(chunks)).toBe(snapshot);
      expect(snapshot).not.toContain(token);
      expect(snapshot).not.toContain("late output");
    } finally {
      controller.abort();
      await run;
    }
  },
  25_000,
);

it.each(["payload", "done"])(
  "normal exit preserves the held ordinary text %j unchanged despite a secret-prefix overlap",
  async (text) => {
    const options = await fixture();
    const chunks: string[] = [];
    const result = await new HostExec(options).runText(
      process.execPath,
      ["-e", `for (const byte of ${JSON.stringify(text)}) process.stdout.write(byte)`],
      {
        env: {
          REVIEW_TOKEN: text === "payload" ? "dummyvalue1234567890" : "done-not-a-real-token",
        },
        onOutput: (_stream, chunk) => chunks.push(chunk),
      },
    );
    expect(result).toMatchObject({ ok: true, data: text });
    expect(chunks.join("")).toBe(text);
  },
);

it.each([
  ["HostExec", "done", { env: { REVIEW_TOKEN: "done-not-a-real-token" } }, "<redacted>"],
  [
    "RecordingExec-over-HostExec",
    "done",
    {
      env: { REVIEW_TOKEN: "done-not-a-real-token" },
    },
    "<redacted>",
  ],
  ["HostExec", "opaque.cre", { stdin: "opaque.credential\n" }, "<redacted>"],
  ["HostExec", "d", { env: { REVIEW_TOKEN: "dummyvalue1234567890" } }, "d"],
  ["HostExec", "du", { env: { REVIEW_TOKEN: "dummyvalue1234567890" } }, "du"],
  ["HostExec", "dum", { env: { REVIEW_TOKEN: "dummyvalue1234567890" } }, "dum"],
  ["HostExec", "Authorization:", {}, "Authorization:"],
  ["HostExec", "parallel=false", { env: { TOKENIZERS_PARALLELISM: "false" } }, "parallel=false"],
  ["HostExec", "Ready", { stdin: "y\n" }, "Ready"],
] satisfies [string, string, ExecOptions, string][])(
  "%s timeout snapshots preserve safe byte-split output and redact held real-secret prefixes in %j",
  async (runner, text, opts, expected) => {
    const options = await fixture();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/TOKEN/i.test(name)),
    );
    const chunks = { stdout: [] as string[], stderr: [] as string[] };
    const child = `
      const text = 'useful output!\\n' + ${JSON.stringify(text)};
      let i = 0;
      const next = () => {
        if (i === text.length) {
          process.stderr.write('ready!\\n');
          return setInterval(() => process.stdout.write('late output'), 1000);
        }
        process.stdout.write(text[i++]);
        setTimeout(next, 10);
      };
      next();
    `;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const host = new HostExec({ ...options, env });
    const exec = runner === "HostExec" ? host : new RecordingExec(host.run, () => {});
    const run = exec.runText(process.execPath, ["-e", child], {
      ...opts,
      timeoutMs: 1000,
      onOutput: (stream, chunk) => chunks[stream].push(chunk),
    });
    try {
      const deadline = Date.now() + PROCESS_WAIT.timeout;
      while (chunks.stderr.join("") !== "ready!\n" && Date.now() < deadline) await delay(10);
      expect(chunks.stderr.join("")).toBe("ready!\n");
    } finally {
      await vi.advanceTimersByTimeAsync(1000);
      await run;
    }
    expect(await run).toMatchObject({ ok: false, error: "Command timed out after 1000ms." });
    expect(chunks.stdout.join("")).toBe(`useful output!\n${expected}`);
    expect(chunks.stderr.join("")).toBe("ready!\n");
    const snapshot = JSON.stringify(chunks);
    await delay(25);
    expect(JSON.stringify(chunks)).toBe(snapshot);
    expect(snapshot).not.toContain("late output");
  },
  25_000,
);

it.each([
  ["HostExec", "cancel", "done-not-a-real-token", "done"],
  ["HostExec", "timeout", "done-not-a-real-token", "done"],
  ["HostExec", "stream error", "done-not-a-real-token", "done"],
  ["RecordingExec-over-HostExec", "cancel", "done-not-a-real-token", "done"],
  ["RecordingExec-over-HostExec", "timeout", "done-not-a-real-token", "done"],
  ["RecordingExec-over-HostExec", "stream error", "done-not-a-real-token", "done"],
  // A secret that spells the marker must not redact the delivered snapshot a second time.
  ["RecordingExec-over-HostExec", "cancel", "redacted", "reda"],
  ["RecordingExec-over-HostExec", "timeout", "redacted", "reda"],
  ["RecordingExec-over-HostExec", "stream error", "redacted", "reda"],
] as const)(
  "%s on %s logs and records the redacted terminal text it delivered for %j, not its held prefix %j",
  async (runner, path, token, held) => {
    const options = await fixture();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/TOKEN/i.test(name)),
    );
    const ready = join(options.appData, "ready");
    const logs: HostExecLog[] = [];
    const lines: string[] = [];
    const chunks = { stdout: [] as string[], stderr: [] as string[] };
    const child = `
      const bytes = (stream, text) => new Promise((done) => {
        let i = 0;
        const next = () => {
          if (i === text.length) return done();
          stream.write(text[i++]);
          setTimeout(next, 10);
        };
        next();
      });
      bytes(process.stdout, 'useful output!\\n${held}')
        .then(() => bytes(process.stderr, 'warning!\\n${held}'))
        .then(() => {
          require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid));
          setInterval(() => {}, 1000);
        });
    `;
    if (path === "timeout") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const injected =
      path === "stream error"
        ? { child: new ChildProcess(), stdout: new PassThrough(), stderr: new PassThrough() }
        : undefined;
    if (injected) {
      injected.child.stdin = new PassThrough();
      injected.child.stdout = injected.stdout;
      injected.child.stderr = injected.stderr;
      vi.mocked(spawn).mockReturnValueOnce(injected.child);
    }
    const controller = new AbortController();
    const host = new HostExec({ ...options, env, log: (entry) => logs.push(entry) });
    const exec =
      runner === "HostExec" ? host : new RecordingExec(host.run, (line) => void lines.push(line));
    const run = exec.runText(process.execPath, ["-e", child], {
      env: { REVIEW_TOKEN: token },
      signal: controller.signal,
      timeoutMs: path === "timeout" ? 1000 : 20_000,
      onOutput: (stream, chunk) => chunks[stream].push(chunk),
    });
    try {
      if (injected) {
        await vi.waitFor(() => expect(injected.stdout.listenerCount("data")).toBe(1));
        for (const byte of `useful output!\n${held}`) injected.stdout.write(byte);
        for (const byte of `warning!\n${held}`) injected.stderr.write(byte);
      } else {
        await waitForPid(ready);
        await delay(100);
      }
      expect(chunks.stdout.join("")).toBe("useful output!\n");
      expect(chunks.stderr.join("")).toBe("warning!\n");
      if (path === "cancel") controller.abort();
      if (injected) {
        const failed = once(injected.stdout, "error");
        injected.stdout.destroy(new Error("stream failed"));
        await failed;
      }
    } catch (failure) {
      controller.abort();
      throw failure;
    } finally {
      injected?.child.emit("close", null);
      if (path === "timeout") await vi.advanceTimersByTimeAsync(1000);
      await run;
    }
    const error = {
      cancel: "Command aborted.",
      timeout: "Command timed out after 1000ms.",
      "stream error": "stream failed",
    }[path];
    expect(await run).toMatchObject({ ok: false, error });
    expect(chunks.stdout.join("")).toBe("useful output!\n<redacted>");
    expect(chunks.stderr.join("")).toBe("warning!\n<redacted>");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ stderr: chunks.stderr.join(""), error });
    if (runner === "RecordingExec-over-HostExec") {
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "")).toMatchObject({
        stdout: chunks.stdout.join(""),
        stderr: chunks.stderr.join(""),
        error,
      });
    }
  },
  25_000,
);

it.each(["HostExec", "RecordingExec-over-HostExec"])(
  "%s with a throwing listener logs, records and delivers the redacted terminal text",
  async (runner) => {
    const options = await fixture();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/TOKEN/i.test(name)),
    );
    const logs: HostExecLog[] = [];
    const lines: string[] = [];
    const chunks = { stdout: [] as string[], stderr: [] as string[] };
    const child = `
      const bytes = (stream, text) => new Promise((done) => {
        let i = 0;
        const next = () => {
          if (i === text.length) return done();
          stream.write(text[i++]);
          setTimeout(next, 10);
        };
        next();
      });
      bytes(process.stderr, 'warning!\\ndone')
        .then(() => bytes(process.stdout, 'ready!\\n'))
        .then(() => setInterval(() => {}, 1000));
    `;
    let thrown = false;
    const host = new HostExec({ ...options, env, log: (entry) => logs.push(entry) });
    const exec =
      runner === "HostExec" ? host : new RecordingExec(host.run, (line) => void lines.push(line));
    const result = await exec.runText(process.execPath, ["-e", child], {
      env: { REVIEW_TOKEN: "done-not-a-real-token" },
      timeoutMs: 20_000,
      onOutput: (stream, chunk) => {
        chunks[stream].push(chunk);
        if (!thrown && chunks.stdout.join("").endsWith("\n")) {
          thrown = true;
          throw new Error("listener failed");
        }
      },
    });
    const error = "Error: listener failed";
    expect(result).toMatchObject({ ok: false, error });
    expect(chunks.stdout.join("")).toBe("ready!\n");
    expect(chunks.stderr.join("")).toBe("warning!\n<redacted>");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ stderr: chunks.stderr.join(""), error });
    if (runner === "RecordingExec-over-HostExec") {
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "")).toMatchObject({
        stdout: chunks.stdout.join(""),
        stderr: chunks.stderr.join(""),
        error,
      });
    }
  },
  25_000,
);

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
  const result = await run;
  expect(result).toMatchObject({ ok: false, error: "Command aborted." });
  if (!result.ok) {
    expect(result.code).not.toBe(0);
    if (process.platform !== "win32") expect(result.code).toBeNull();
  }
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

it("creates app-owned kube and azure configuration directories after a run", async () => {
  const options = await fixture();
  const exec = new HostExec(options);
  expect(await exec.runText(process.execPath, ["-e", ""])).toEqual({
    ok: true,
    data: "",
    exitCode: 0,
  });
  expect((await stat(join(options.appData, "kube"))).isDirectory()).toBe(true);
  expect((await stat(join(options.appData, "azure"))).isDirectory()).toBe(true);
});

it("assigns app-owned config paths and scrubs overrides, keeping only the named token", async () => {
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
  const chunks: string[] = [];
  const pidFile = join(options.appData, "pid");
  const grandchild = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
  const parent = `process.stdout.write('done'); process.on('SIGTERM', () => {}); require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio: 'inherit'}); setInterval(() => {}, 1000)`;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const result = new HostExec(options).runText(process.execPath, ["-e", parent], {
    timeoutMs: 1000,
    env: { REVIEW_TOKEN: "done-not-a-real-token" },
    onOutput: (_stream, chunk) => chunks.push(chunk),
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
  expect(chunks.join("")).toBe("<redacted>");
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
