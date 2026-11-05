// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SetupToolSchema } from "@spi-code/contracts";
import { type Exec, GITLAB_HOST } from "@spi-code/core";
import { z } from "zod";

export const GH_HOST = "github.com";
export const GH_REQUIRED_SCOPES = ["repo", "workflow"] as const;
// The sweeps only read GitLab, so either API scope is enough.
const GLAB_ACCEPTED_SCOPES = ["api", "read_api"] as const;

type ToolStatus = Omit<z.infer<typeof SetupToolSchema>, "tool">;

export const CLASSIC_TOKEN_REASON =
  "A classic ghp_ personal access token is configured instead of the gh OAuth sign-in. Remove it and sign in with gh auth login --web so the repo and workflow scopes come from the browser.";
const GH_SIGNED_OUT = "gh is not signed in to github.com.";
const GH_UNREADABLE = "gh did not report its sign-in state.";
const GLAB_SIGNED_OUT = `glab is not signed in to ${GITLAB_HOST}.`;
const GLAB_UNREADABLE = "glab did not report its sign-in state.";
const STATUS_TIMEOUT_MS = 15_000;

// glab reads these before its own store, so blank them to make probes check the stored login.
const GLAB_STRAY_TOKENS = ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN"] as const;

/** Environment for glab calls: stray tokens blanked, and `token` set only when given. */
export function glabEnv(token?: string): Record<string, string> {
  const env = Object.fromEntries(GLAB_STRAY_TOKENS.map((name) => [name, ""]));
  if (token !== undefined) env.GITLAB_TOKEN = token;
  return env;
}

/** Runs a command and returns stdout plus the stderr that tools such as gh use for status. */
async function capture(
  exec: Exec,
  cmd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<{ ok: true; text: string; exit: number | null } | { ok: false }> {
  let streamed = "";
  const result = await exec.runText(cmd, args, {
    acceptNonZeroExit: true,
    timeoutMs: STATUS_TIMEOUT_MS,
    ...(env ? { env } : {}),
    onOutput: (stream, text) => {
      if (stream === "stderr") streamed += text;
    },
  });
  if (!result.ok) return { ok: false };
  return { ok: true, text: `${result.data}\n${streamed}`, exit: result.exitCode ?? null };
}

/** Scopes from the `Token scopes:` line of `gh auth status`. */
export function parseGhScopes(text: string): string[] | undefined {
  const line = /Token scopes:\s*(.*)$/m.exec(text)?.[1];
  if (!line) return undefined;
  const scopes = [...line.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? "").filter(Boolean);
  return scopes.length > 0 ? scopes : undefined;
}

/** The block for the active account, or the whole text when gh does not mark one. */
export function activeGhAccount(text: string): string {
  const blocks = text.split(/^(?=\s*\S+\s+Logged in to )/m);
  const active = blocks.find((block) => /Active account:\s*true/i.test(block));
  return active ?? text;
}

/** gh masks the token but keeps its prefix, and a classic personal access token starts ghp_. */
export function isClassicGhToken(text: string): boolean {
  return /^\s*-?\s*Token:\s*ghp_/m.test(activeGhAccount(text));
}

export async function ghStatus(exec: Exec): Promise<ToolStatus> {
  const probe = await capture(exec, "gh", ["auth", "status", "--hostname", GH_HOST]);
  if (!probe.ok) return { state: "failed", action: "attention", reason: GH_UNREADABLE };
  if (probe.exit !== 0 || !/Logged in to/i.test(probe.text)) {
    return { state: "signed-out", action: "signin", reason: GH_SIGNED_OUT };
  }
  const scopes = parseGhScopes(activeGhAccount(probe.text));
  if (isClassicGhToken(probe.text)) {
    return {
      state: "classic-token",
      action: "attention",
      reason: CLASSIC_TOKEN_REASON,
      ...(scopes ? { scopes } : {}),
    };
  }
  // Fine-grained and app tokens print no scope list, so there is nothing to compare.
  if (!scopes) return { state: "ready", action: null };
  const missingScopes = GH_REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope));
  if (missingScopes.length === 0) return { state: "ready", action: null, scopes };
  return {
    state: "scope-missing",
    action: "signin",
    scopes,
    missingScopes,
    reason: `gh is missing the ${missingScopes.join(" and ")} scope. Sign in again to grant it.`,
  };
}

const PatSelfSchema = z.object({ scopes: z.array(z.string()) });

export type GlabScopes = { ok: true; scopes: string[] } | { ok: false };

export interface GlabScopeOptions {
  /** A token to check instead of the stored one, passed only through the environment. */
  token?: string;
  signal?: AbortSignal;
}

/** Asks GitLab which scopes a token holds. Anything but a parseable scope record is not ok. */
export async function glabScopes(exec: Exec, options: GlabScopeOptions = {}): Promise<GlabScopes> {
  const result = await exec.runText(
    "glab",
    ["api", "personal_access_tokens/self", "--hostname", GITLAB_HOST],
    {
      acceptNonZeroExit: true,
      timeoutMs: STATUS_TIMEOUT_MS,
      env: glabEnv(options.token),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  if (!result.ok || result.exitCode !== 0) return { ok: false };
  try {
    const parsed = PatSelfSchema.safeParse(JSON.parse(result.data.slice(result.data.indexOf("{"))));
    return parsed.success ? { ok: true, scopes: parsed.data.scopes } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function hasGlabScope(scopes: readonly string[]): boolean {
  return GLAB_ACCEPTED_SCOPES.some((scope) => scopes.includes(scope));
}

export const GLAB_SCOPE_REASON = "The GitLab token needs the api or read_api scope.";

export async function glabStatus(exec: Exec): Promise<ToolStatus> {
  const probe = await capture(
    exec,
    "glab",
    ["auth", "status", "--hostname", GITLAB_HOST],
    glabEnv(),
  );
  if (!probe.ok) return { state: "failed", action: "attention", reason: GLAB_UNREADABLE };
  const signedIn =
    probe.exit === 0 &&
    /Logged in to/i.test(probe.text) &&
    !/not (?:been )?authenticated|API call failed/i.test(probe.text);
  if (!signedIn) return { state: "signed-out", action: "signin", reason: GLAB_SIGNED_OUT };
  const found = await glabScopes(exec);
  if (!found.ok) return { state: "signed-out", action: "signin", reason: GLAB_SIGNED_OUT };
  const scopes = found.scopes;
  if (hasGlabScope(scopes)) {
    return { state: "ready", action: null, scopes };
  }
  return {
    state: "scope-missing",
    action: "signin",
    scopes,
    missingScopes: ["api"],
    reason: `${GLAB_SCOPE_REASON} Sign in again with a token that has one.`,
  };
}
