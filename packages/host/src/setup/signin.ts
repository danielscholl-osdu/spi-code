// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type SetupSigninProgress, SetupSigninProgressSchema } from "@spi-code/contracts";
import { type Exec, GITLAB_HOST } from "@spi-code/core";
import {
  GH_HOST,
  GH_REQUIRED_SCOPES,
  GLAB_SCOPE_REASON,
  glabEnv,
  glabScopes,
  hasGlabScope,
} from "./status.js";

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
  glabScope: GLAB_SCOPE_REASON,
  glabFailed: "glab could not store the token.",
} as const;

const GH_LOGIN_TIMEOUT_MS = 5 * 60_000;
const GLAB_LOGIN_TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT = 16_384;

// Both forms gh prints: "(CODE)" after copying, "First copy your one-time code: CODE" otherwise.
const DEVICE_CODE = /one-time code(?:\s*\(|:\s*)([A-Z0-9]{4}(?:-[A-Z0-9]{4})+)(?=[\s)])/i;
// The URL counts only once something follows it, so a chunk cut mid-URL is never shown.
const DEVICE_URL = /https?:\/\/[^\s)]+(?=[\s)])/;

// CSI (colors), OSC (hyperlinks, ended by BEL or ST) and two-character escapes. An escape cut at
// the end of a chunk stays in place, so the value next to it cannot match until it completes.
const ANSI_ESCAPE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes in gh output
  /\u001b(?:\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\^_])/g;

/** Parses the one-time code and verification URL from `gh auth login --web` output. */
export function parseGhDeviceCode(text: string): { deviceCode: string; url: string } | undefined {
  const plain = text.replace(ANSI_ESCAPE, "");
  const deviceCode = DEVICE_CODE.exec(plain)?.[1];
  const url = DEVICE_URL.exec(plain)?.[0];
  if (!deviceCode || !url) return undefined;
  return { deviceCode, url };
}

// gh honours an inherited GH_FORCE_TTY or CLICOLOR_FORCE when piped, which colors the code and
// waits for Enter. Empty values count as unset to gh; a fresh object keeps callers' env intact.
function ghEnv(): Record<string, string> {
  return { NO_COLOR: "1", GH_FORCE_TTY: "", CLICOLOR_FORCE: "" };
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
      env: ghEnv(),
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
 * Signs glab in to the stack's GitLab. The pinned glab has no web flow and does not validate a
 * token it is given, so GitLab is asked first, with the token only in the probe's environment,
 * and the token is piped to `--stdin` (into glab's own config file) only once it qualifies.
 */
export async function signinGlab(
  exec: Exec,
  token: string,
  options: SigninOptions,
): Promise<SigninOutcome> {
  emit(options, { tool: "glab", state: "starting" });
  const secret = token.trim();
  if (!isTokenShaped(secret)) return failed(options, "glab", REASON.glabBadToken);
  const cancelled = () => failed(options, "glab", REASON.cancelled);
  const signal = options.signal ? { signal: options.signal } : {};
  emit(options, { tool: "glab", state: "waiting" });
  const probe = await glabScopes(exec, { token: secret, ...signal });
  if (options.signal?.aborted) return cancelled();
  if (!probe.ok) return failed(options, "glab", REASON.glabRejected);
  if (!hasGlabScope(probe.scopes)) return failed(options, "glab", REASON.glabScope);
  const login = await exec.runText(
    "glab",
    [
      "auth",
      "login",
      "--hostname",
      GITLAB_HOST,
      "--stdin",
      "--git-protocol",
      "https",
      "--api-protocol",
      "https",
    ],
    {
      stdin: `${secret}\n`,
      env: glabEnv(),
      timeoutMs: options.timeoutMs ?? GLAB_LOGIN_TIMEOUT_MS,
      ...signal,
    },
  );
  if (options.signal?.aborted) return cancelled();
  if (!login.ok) return failed(options, "glab", REASON.glabFailed);
  const stored = await glabScopes(exec, signal);
  if (options.signal?.aborted) return cancelled();
  if (!stored.ok || !hasGlabScope(stored.scopes)) return failed(options, "glab", REASON.glabFailed);
  emit(options, { tool: "glab", state: "completed" });
  return { state: "completed" };
}
