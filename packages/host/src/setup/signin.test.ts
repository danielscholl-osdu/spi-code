// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SetupSigninProgressSchema } from "@spi-code/contracts";
import type { Exec, ExecOptions, ExecResult } from "@spi-code/core";
import { expect, it } from "vitest";
import { HostExec, type HostExecLog } from "../exec/host-exec.js";
import {
  isTokenShaped,
  parseGhDeviceCode,
  type SigninProgress,
  signinGh,
  signinGlab,
} from "./signin.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const TOKEN = "glpat-Zq83kLm29xTrV0wYb71nC";

interface Call {
  cmd: string;
  args: string[];
  stdin: string | undefined;
}

type Handler = (call: Call, opts: ExecOptions) => Promise<ExecResult<string>> | ExecResult<string>;

function fakeExec(handler: Handler): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const runText = async (cmd: string, args: string[], opts: ExecOptions = {}) => {
    const call = { cmd, args, stdin: opts.stdin };
    calls.push(call);
    return handler(call, opts);
  };
  return {
    exec: { runText, runJSON: async () => ({ ok: false, error: "unused", code: null }) },
    calls,
  };
}

function recorder() {
  const progress: SigninProgress[] = [];
  return { progress, report: (value: SigninProgress) => progress.push(value) };
}

it("parses the device code and URL from recorded gh output", () => {
  expect(parseGhDeviceCode(fixture("gh-login-device.txt"))).toEqual({
    deviceCode: "9C4F-D809",
    url: "https://github.com/login/device",
  });
  expect(parseGhDeviceCode("Logging in…")).toBeUndefined();
});

it("sends the gh device code as soon as it appears, split across chunks, before gh exits", async () => {
  const text = fixture("gh-login-device.txt");
  let finish: (result: ExecResult<string>) => void = () => {};
  const { exec, calls } = fakeExec(
    (_call, opts) =>
      new Promise((resolve) => {
        finish = resolve;
        const cut = text.indexOf("D809");
        opts.onOutput?.("stderr", text.slice(0, cut));
        opts.onOutput?.("stderr", text.slice(cut));
      }),
  );
  const { progress, report } = recorder();
  const pending = signinGh(exec, { report });
  await Promise.resolve();
  expect(progress.map((entry) => entry.state)).toEqual(["starting", "device-code", "waiting"]);
  expect(progress[1]).toMatchObject({
    tool: "gh",
    deviceCode: "9C4F-D809",
    url: "https://github.com/login/device",
  });
  expect(calls[0]?.args).toEqual([
    "auth",
    "login",
    "--web",
    "-s",
    "repo,workflow",
    "--hostname",
    "github.com",
  ]);
  finish({ ok: true, data: "", exitCode: 0 });
  expect(await pending).toEqual({ state: "completed" });
  expect(progress.at(-1)).toEqual({ tool: "gh", state: "completed" });
  for (const entry of progress)
    expect(SetupSigninProgressSchema.safeParse(entry).success).toBe(true);
});

it("reports a fixed reason when gh fails or is cancelled, never gh's own text", async () => {
  const failing = fakeExec(() => ({
    ok: false,
    error: "network down ghp_abcdefghijklmnop",
    code: 1,
  }));
  const first = recorder();
  const outcome = await signinGh(failing.exec, { report: first.report });
  expect(outcome).toEqual({ state: "failed", reason: "gh did not show a one-time code." });
  expect(JSON.stringify(first.progress)).not.toContain("ghp_");

  const controller = new AbortController();
  const aborting = fakeExec(() => {
    controller.abort();
    return { ok: false, error: "Command aborted.", code: null };
  });
  const second = recorder();
  expect(
    await signinGh(aborting.exec, { report: second.report, signal: controller.signal }),
  ).toEqual({
    state: "failed",
    reason: "Sign-in was cancelled.",
  });
});

const glabHandler =
  (opts: { loginError?: string; scopesOk: boolean }): Handler =>
  ({ args }) => {
    if (args[0] === "auth" && args[1] === "login") {
      return opts.loginError
        ? { ok: false, error: `${opts.loginError} ${TOKEN}`, code: 1 }
        : { ok: true, data: "", exitCode: 0 };
    }
    if (args[0] === "api") {
      return opts.scopesOk
        ? { ok: true, data: fixture("glab-pat-self.json"), exitCode: 0 }
        : { ok: true, data: '{"message":"401 Unauthorized"}', exitCode: 1 };
    }
    return { ok: true, data: "", exitCode: 0 };
  };

it("signs glab in with the token on stdin only, and never leaks it", async () => {
  const { exec, calls } = fakeExec(glabHandler({ scopesOk: true }));
  const { progress, report } = recorder();
  const outcome = await signinGlab(exec, `  ${TOKEN}\n`, { report });
  expect(outcome).toEqual({ state: "completed" });
  const login = calls[0];
  expect(login?.stdin).toBe(`${TOKEN}\n`);
  expect(login?.args).toEqual([
    "auth",
    "login",
    "--hostname",
    "community.opengroup.org",
    "--stdin",
    "--use-keyring",
    "--git-protocol",
    "https",
    "--api-protocol",
    "https",
  ]);
  const seen = JSON.stringify({ args: calls.map((call) => call.args), progress, outcome });
  expect(seen).not.toContain(TOKEN);
  expect(progress.map((entry) => entry.state)).toEqual(["starting", "waiting", "completed"]);
});

it("removes a token GitLab rejects and reports a fixed reason", async () => {
  const { exec, calls } = fakeExec(glabHandler({ scopesOk: false }));
  const { progress, report } = recorder();
  const outcome = await signinGlab(exec, TOKEN, { report });
  expect(outcome).toEqual({ state: "failed", reason: "GitLab did not accept that token." });
  expect(calls.at(-1)?.args).toEqual(["auth", "logout", "--hostname", "community.opengroup.org"]);
  expect(JSON.stringify({ progress, outcome, args: calls.map((call) => call.args) })).not.toContain(
    TOKEN,
  );
});

it("keeps the token out of the reply when glab login itself fails", async () => {
  const { exec, calls } = fakeExec(glabHandler({ loginError: "glab: bad token", scopesOk: true }));
  const { progress, report } = recorder();
  const outcome = await signinGlab(exec, TOKEN, { report });
  expect(outcome).toEqual({ state: "failed", reason: "glab could not store the token." });
  expect(JSON.stringify({ progress, outcome, args: calls.map((call) => call.args) })).not.toContain(
    TOKEN,
  );
  expect(calls).toHaveLength(1);
});

it("rejects a value that is not shaped like a token without running glab or echoing it", async () => {
  const { exec, calls } = fakeExec(glabHandler({ scopesOk: true }));
  const { progress, report } = recorder();
  const pasted = "my password is hunter2 hunter2";
  const outcome = await signinGlab(exec, pasted, { report });
  expect(outcome).toEqual({ state: "failed", reason: "That token is not in the expected form." });
  expect(calls).toHaveLength(0);
  expect(JSON.stringify({ progress, outcome })).not.toContain("hunter2");
  expect(isTokenShaped(TOKEN)).toBe(true);
  expect(isTokenShaped("short")).toBe(false);
});

it.skipIf(process.platform === "win32")(
  "keeps the token out of the host log when glab echoes its stdin on failure",
  async () => {
    const bin = await mkdtemp(join(tmpdir(), "spi-signin-"));
    try {
      const script = join(bin, "glab");
      await writeFile(script, '#!/bin/sh\ncat >&2\necho "rejected $(cat /dev/null)" >&2\nexit 1\n');
      await chmod(script, 0o755);
      const logs: HostExecLog[] = [];
      const exec = new HostExec({
        appData: bin,
        capturedPath: `${bin}:${process.env.PATH ?? ""}`,
        installer: { binDir: async () => undefined },
        log: (entry) => logs.push(entry),
      });
      const { progress, report } = recorder();
      const outcome = await signinGlab(exec, TOKEN, { report });
      expect(outcome).toEqual({ state: "failed", reason: "glab could not store the token." });
      expect(logs.length).toBeGreaterThan(0);
      expect(JSON.stringify({ logs, progress, outcome })).not.toContain(TOKEN);
    } finally {
      await rm(bin, { recursive: true, force: true });
    }
  },
);
