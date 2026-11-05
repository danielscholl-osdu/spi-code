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

it("parses the fallback line gh prints when it cannot copy the code", () => {
  expect(parseGhDeviceCode(fixture("gh-login-device-fallback.txt"))).toEqual({
    deviceCode: "9C4F-D809",
    url: "https://github.com/login/device",
  });
});

it("waits for the code terminator when the URL is already present", () => {
  for (const prefix of ["one-time code (", "First copy your one-time code: "]) {
    const text = `https://github.com/login/device\n${prefix}9C4F-D809-ABCD\n`;
    for (let cut = text.indexOf("9C4F"); cut < text.length; cut++) {
      expect(parseGhDeviceCode(text.slice(0, cut))).toBeUndefined();
    }
    expect(parseGhDeviceCode(text)).toEqual({
      deviceCode: "9C4F-D809-ABCD",
      url: "https://github.com/login/device",
    });
  }
});

const HYPERLINKED =
  "First copy your one-time code: \x1b[1m9C4F-D809\x1b[0m\nOpen \x1b]8;;https://github.com/login/device\x07https://github.com/login/device\x1b]8;;\x07\n";

it("parses the code and URL when gh wraps them in ANSI color escapes", () => {
  expect(parseGhDeviceCode(fixture("gh-login-device-color.txt"))).toEqual({
    deviceCode: "9C4F-D809",
    url: "https://github.com/login/device",
  });
  expect(parseGhDeviceCode(HYPERLINKED)).toEqual({
    deviceCode: "9C4F-D809",
    url: "https://github.com/login/device",
  });
});

it("never shows a truncated URL or code, splitting the output at every position", async () => {
  for (const text of [
    fixture("gh-login-device.txt"),
    fixture("gh-login-device-fallback.txt"),
    fixture("gh-login-device-color.txt"),
    HYPERLINKED,
  ]) {
    for (let cut = 1; cut < text.length; cut++) {
      const { exec } = fakeExec(async (_call, opts) => {
        opts.onOutput?.("stderr", text.slice(0, cut));
        opts.onOutput?.("stderr", text.slice(cut));
        return { ok: true, data: "", exitCode: 0 };
      });
      const { progress, report } = recorder();
      await signinGh(exec, { report });
      const shown = progress.filter((entry) => entry.state === "device-code");
      expect(shown).toEqual([
        {
          tool: "gh",
          state: "device-code",
          deviceCode: "9C4F-D809",
          url: "https://github.com/login/device",
        },
      ]);
    }
  }
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

it("runs gh with forced TTY and color neutralised, leaving the caller's environment alone", async () => {
  const saved = { ...process.env };
  process.env.GH_FORCE_TTY = "1";
  process.env.CLICOLOR_FORCE = "1";
  try {
    const envs: (Record<string, string> | undefined)[] = [];
    const { exec } = fakeExec((_call, opts) => {
      envs.push(opts.env);
      return { ok: true, data: "", exitCode: 0 };
    });
    await signinGh(exec, { report: recorder().report });
    await signinGh(exec, { report: recorder().report });
    expect(envs[0]).toEqual({ NO_COLOR: "1", GH_FORCE_TTY: "", CLICOLOR_FORCE: "" });
    expect(envs[1]).toEqual(envs[0]);
    expect(envs[1]).not.toBe(envs[0]);
    expect(process.env.GH_FORCE_TTY).toBe("1");
    expect(process.env.CLICOLOR_FORCE).toBe("1");
  } finally {
    process.env = saved;
  }
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
  (opts: { loginError?: string; pat?: string; patExit?: number }): Handler =>
  ({ args }) => {
    if (args[0] === "auth" && args[1] === "login") {
      return opts.loginError
        ? { ok: false, error: `${opts.loginError} ${TOKEN}`, code: 1 }
        : { ok: true, data: "", exitCode: 0 };
    }
    if (args[0] === "api") {
      return {
        ok: true,
        data: opts.pat ?? fixture("glab-pat-self.json"),
        exitCode: opts.patExit ?? 0,
      };
    }
    return { ok: true, data: "", exitCode: 0 };
  };

const everything = (calls: unknown, progress: unknown, outcome: unknown) =>
  JSON.stringify({ calls, progress, outcome });

it("verifies the token through the environment, then stores it on stdin without the keyring", async () => {
  const envs: (Record<string, string> | undefined)[] = [];
  const { exec, calls } = fakeExec((call, opts) => {
    envs.push(opts.env);
    return glabHandler({})(call, opts);
  });
  const { progress, report } = recorder();
  const outcome = await signinGlab(exec, `  ${TOKEN}\n`, { report });
  expect(outcome).toEqual({ state: "completed" });
  expect(calls.map((call) => call.args.slice(0, 2).join(" "))).toEqual([
    "api personal_access_tokens/self",
    "auth login",
    "api personal_access_tokens/self",
  ]);
  expect(envs[0]?.GITLAB_TOKEN).toBe(TOKEN);
  expect(calls[0]?.stdin).toBeUndefined();
  expect(calls[1]?.stdin).toBe(`${TOKEN}\n`);
  expect(calls[1]?.args).toEqual([
    "auth",
    "login",
    "--hostname",
    "community.opengroup.org",
    "--stdin",
    "--git-protocol",
    "https",
    "--api-protocol",
    "https",
  ]);
  expect(calls[1]?.args).not.toContain("--use-keyring");
  expect(envs[1]?.GITLAB_TOKEN).toBe("");
  expect(envs[2]?.GITLAB_TOKEN).toBe("");
  expect(
    everything(
      calls.map((call) => call.args),
      progress,
      outcome,
    ),
  ).not.toContain(TOKEN);
  expect(progress.map((entry) => entry.state)).toEqual(["starting", "waiting", "completed"]);
});

it("blanks stray GitLab tokens for every glab call", async () => {
  const envs: (Record<string, string> | undefined)[] = [];
  const { exec } = fakeExec((call, opts) => {
    envs.push(opts.env);
    return glabHandler({})(call, opts);
  });
  await signinGlab(exec, TOKEN, { report: recorder().report });
  for (const env of envs) {
    expect(env?.GITLAB_ACCESS_TOKEN).toBe("");
    expect(env?.OAUTH_TOKEN).toBe("");
  }
});

it("never stores a token GitLab rejects, so an existing sign-in is untouched", async () => {
  for (const pat of [
    { pat: '{"message":"401 Unauthorized"}', patExit: 1 },
    { pat: "<html>proxy</html>" },
    { pat: "{}" },
  ]) {
    const { exec, calls } = fakeExec(glabHandler(pat));
    const { progress, report } = recorder();
    const outcome = await signinGlab(exec, TOKEN, { report });
    expect(outcome).toEqual({ state: "failed", reason: "GitLab did not accept that token." });
    expect(calls).toHaveLength(1);
    expect(calls.some((call) => call.args.includes("login") || call.args.includes("logout"))).toBe(
      false,
    );
    expect(
      everything(
        calls.map((call) => call.args),
        progress,
        outcome,
      ),
    ).not.toContain(TOKEN);
  }
});

it("refuses a token with neither api nor read_api and does not store it", async () => {
  const { exec, calls } = fakeExec(glabHandler({ pat: fixture("glab-pat-self-no-api.json") }));
  const { progress, report } = recorder();
  const outcome = await signinGlab(exec, TOKEN, { report });
  expect(outcome).toEqual({
    state: "failed",
    reason: "The GitLab token needs the api or read_api scope.",
  });
  expect(calls).toHaveLength(1);
  expect(everything(calls, progress, outcome)).not.toContain(TOKEN);
});

it("keeps the token out of the reply when glab login itself fails", async () => {
  const { exec, calls } = fakeExec(glabHandler({ loginError: "glab: bad token" }));
  const { progress, report } = recorder();
  const outcome = await signinGlab(exec, TOKEN, { report });
  expect(outcome).toEqual({ state: "failed", reason: "glab could not store the token." });
  expect(
    everything(
      calls.map((call) => call.args),
      progress,
      outcome,
    ),
  ).not.toContain(TOKEN);
  expect(calls).toHaveLength(2);
});

it("fails when the stored sign-in cannot be confirmed", async () => {
  let probes = 0;
  const { exec } = fakeExec((call, opts) => {
    if (call.args[0] === "api" && ++probes === 2) {
      return { ok: true, data: "{}", exitCode: 0 };
    }
    return glabHandler({})(call, opts);
  });
  const outcome = await signinGlab(exec, TOKEN, { report: recorder().report });
  expect(outcome).toEqual({ state: "failed", reason: "glab could not store the token." });
});

it("never reports completed after a cancel, whichever step it lands in", async () => {
  for (const step of [1, 2, 3]) {
    const controller = new AbortController();
    let seen = 0;
    const { exec, calls } = fakeExec((call, opts) => {
      expect(opts.signal).toBe(controller.signal);
      if (++seen === step) controller.abort();
      return glabHandler({})(call, opts);
    });
    const { progress, report } = recorder();
    const outcome = await signinGlab(exec, TOKEN, { report, signal: controller.signal });
    expect(outcome).toEqual({ state: "failed", reason: "Sign-in was cancelled." });
    expect(progress.map((entry) => entry.state)).not.toContain("completed");
    expect(calls).toHaveLength(step);
    if (step === 1) {
      expect(calls.some((call) => call.args.includes("login"))).toBe(false);
    }
  }
});

it("rejects a value that is not shaped like a token without running glab or echoing it", async () => {
  const { exec, calls } = fakeExec(glabHandler({}));
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
  "keeps the token out of the host log when glab echoes its environment and stdin",
  async () => {
    const bin = await mkdtemp(join(tmpdir(), "spi-signin-"));
    try {
      const script = join(bin, "glab");
      await writeFile(script, '#!/bin/sh\ncat >&2\necho "rejected $GITLAB_TOKEN" >&2\nexit 1\n');
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
      expect(outcome).toEqual({ state: "failed", reason: "GitLab did not accept that token." });
      expect(logs.length).toBeGreaterThan(0);
      expect(JSON.stringify({ logs, progress, outcome })).not.toContain(TOKEN);
    } finally {
      await rm(bin, { recursive: true, force: true });
    }
  },
);
