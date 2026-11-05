// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type SetupSigninProgress, SetupSigninProgressSchema } from "@spi-code/contracts";
import { type Exec, GITLAB_HOST } from "@spi-code/core";
import { GH_HOST, GH_REQUIRED_SCOPES, glabScopes } from "./status.js";

export type SigninProgress = SetupSigninProgress;
export type SigninOutcome = { state: "completed" } | { state: "failed"; reason: string };

export interface SigninOptions {
  /** Receives schema-valid progress. Device codes are only ever delivered here. */
  report: (progress: SigninProgress) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

// Reasons are fixed strings: tool output can quote credentials or validation detail.
const REASON = {
  cancelled: "Sign-in was cancelled.",
  ghFailed: "gh sign-in did not complete.",
  ghNoCode: "gh did not show a one-time code.",
  glabBadToken: "That token is not in the expected form.",
  glabRejected: "GitLab did not accept that token.",
  glabFailed: "glab could not store the token.",
} as const;

const GH_LOGIN_TIMEOUT_MS = 5 * 60_000;
const GLAB_LOGIN_TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT = 16_384;

const DEVICE_CODE = /one-time code\s*\(([A-Z0-9]{4}(?:-[A-Z0-9]{4})+)\)/i;
const DEVICE_URL = /https?:\/\/[^\s)]+/;

/** Parses the one-time code and verification URL from `gh auth login --web` output. */
export function parseGhDeviceCode(text: string): { deviceCode: string; url: string } | undefined {
  const deviceCode = DEVICE_CODE.exec(text)?.[1];
  const url = DEVICE_URL.exec(text)?.[0];
  if (!deviceCode || !url) return undefined;
  return { deviceCode, url };
}

const TOKEN_FORM = /^[\x21-\x7e]{16,512}$/;

/** True when the value looks like a pasted access token: one run of printable characters. */
export function isTokenShaped(token: string): boolean {
  return TOKEN_FORM.test(token);
}

function emit(options: SigninOptions, progress: SigninProgress): void {
  options.report(SetupSigninProgressSchema.parse(progress));
}

function failed(options: SigninOptions, tool: "gh" | "glab", reason: string): SigninOutcome {
  emit(options, { tool, state: "failed", reason });
  return { state: "failed", reason };
}

export async function signinGh(exec: Exec, options: SigninOptions): Promise<SigninOutcome> {
  emit(options, { tool: "gh", state: "starting" });
  let seen = "";
  let shown = false;
  const result = await exec.runText(
    "gh",
    ["auth", "login", "--web", "-s", GH_REQUIRED_SCOPES.join(","), "--hostname", GH_HOST],
    {
      timeoutMs: options.timeoutMs ?? GH_LOGIN_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
      onOutput: (_stream, text) => {
        if (shown) return;
        seen = (seen + text).slice(-OUTPUT_LIMIT);
        const code = parseGhDeviceCode(seen);
        if (!code) return;
        shown = true;
        seen = "";
        emit(options, { tool: "gh", state: "device-code", ...code });
        emit(options, { tool: "gh", state: "waiting" });
      },
    },
  );
  if (options.signal?.aborted) return failed(options, "gh", REASON.cancelled);
  if (!result.ok) return failed(options, "gh", shown ? REASON.ghFailed : REASON.ghNoCode);
  emit(options, { tool: "gh", state: "completed" });
  return { state: "completed" };
}

/**
 * Signs glab in to the stack's GitLab by piping the token to `--stdin`. The pinned glab has
 * no web flow, and the token lives only in `token` for the length of this call.
 */
export async function signinGlab(
  exec: Exec,
  token: string,
  options: SigninOptions,
): Promise<SigninOutcome> {
  emit(options, { tool: "glab", state: "starting" });
  const secret = token.trim();
  if (!isTokenShaped(secret)) return failed(options, "glab", REASON.glabBadToken);
  const login = await exec.runText(
    "glab",
    [
      "auth",
      "login",
      "--hostname",
      GITLAB_HOST,
      "--stdin",
      "--use-keyring",
      "--git-protocol",
      "https",
      "--api-protocol",
      "https",
    ],
    {
      stdin: `${secret}\n`,
      timeoutMs: options.timeoutMs ?? GLAB_LOGIN_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  if (options.signal?.aborted) return failed(options, "glab", REASON.cancelled);
  if (!login.ok) return failed(options, "glab", REASON.glabFailed);
  emit(options, { tool: "glab", state: "waiting" });
  // glab 1.74 stores a token without validating it, so ask GitLab before reporting success.
  const probe = await glabScopes(exec);
  if (!probe.ok) {
    await exec.runText("glab", ["auth", "logout", "--hostname", GITLAB_HOST], {
      acceptNonZeroExit: true,
      timeoutMs: GLAB_LOGIN_TIMEOUT_MS,
    });
    return failed(options, "glab", REASON.glabRejected);
  }
  emit(options, { tool: "glab", state: "completed" });
  return { state: "completed" };
}
