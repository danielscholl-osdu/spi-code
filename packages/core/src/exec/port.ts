// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { MIN_SECRET_LENGTH, REDACTED, redact } from "./redact.js";

export type ExecResult<T> =
  | { ok: true; data: T; exitCode?: number | null; stderr?: string }
  | { ok: false; error: string; code: number | null };

export interface ExecOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
  cwd?: string;
  acceptNonZeroExit?: boolean;
  stdin?: string;
  signal?: AbortSignal;
  /** Redacted live output, plus a final snapshot per buffered stream on cancellation with secret prefixes masked. */
  onOutput?: (stream: "stdout" | "stderr", text: string) => void;
}

export function execRedactor(opts: ExecOptions, env: Record<string, string> = {}) {
  const secrets = { ...env, ...opts.env };
  const input = opts.stdin?.trim();
  return (text: string): string =>
    redact(input && input.length >= MIN_SECRET_LENGTH ? text.split(input).join(REDACTED) : text, secrets);
}

export function execOutputDelivery(opts: ExecOptions, env: Record<string, string> = {}) {
  const safe = execRedactor(opts, env);
  const secrets = Object.entries({ ...env, ...opts.env })
    .filter(([name, value]) => /TOKEN/i.test(name) && value.length >= MIN_SECRET_LENGTH)
    .map(([, value]) => value);
  const input = opts.stdin?.trim();
  if (input && input.length >= MIN_SECRET_LENGTH) secrets.push(input);
  const prefixes = ["gho_", "ghp_", "ghs_", "ghu_", "ghr_", "github_pat_", "glpat-", "authorization", "bearer"];
  const pending = { stdout: "", stderr: "" };
  let finished = false;
  const prefixStart = (text: string) => {
    let end = text.length;
    const candidates: [string, string][] = [
      ...prefixes.map((prefix): [string, string] => [text.toLowerCase(), prefix]),
      ...secrets.map((secret): [string, string] => [text, secret]),
    ];
    for (const [value, candidate] of candidates) {
      for (let length = Math.min(value.length, candidate.length); length > 0; length--) {
        if (value.endsWith(candidate.slice(0, length))) {
          end = Math.min(end, text.length - length);
          break;
        }
      }
    }
    return end;
  };
  const cancelledSnapshot = (text: string) => {
    const redacted = safe(text);
    const end = prefixStart(text);
    if (end === text.length) return redacted;
    // A held prefix can overlap a complete secret. Only retain their shared redacted prefix.
    const before = safe(text.slice(0, end));
    let shared = 0;
    while (shared < before.length && shared < redacted.length && before[shared] === redacted[shared]) shared++;
    if (shared === redacted.length) return redacted;
    const marker = redacted.lastIndexOf(REDACTED, shared);
    if (marker >= 0 && shared < marker + REDACTED.length) shared = marker;
    return redacted.slice(0, shared) + REDACTED;
  };
  const push = (stream: "stdout" | "stderr", chunk: string) => {
    if (finished || !opts.onOutput || opts.signal?.aborted) return;
    pending[stream] += chunk;
    const text = pending[stream];
    const redacted = safe(text);
    // Do not publish a suffix whose redaction can change when the next chunk arrives.
    let end = prefixStart(text);
    // The next character may complete an escape that establishes a header boundary.
    if (text.endsWith("\\")) end = Math.min(end, text.length - 1);
    const credential = text.search(/(?:gh[opsur]_|github_pat_|glpat-)[A-Za-z0-9_-]*$/);
    if (credential >= 0) end = Math.min(end, credential);
    const header = text.search(
      /(?:authorization|bearer)[^\r\n]*\s*$|(?:authorization|bearer)(?=((?:\s|[:="']|\\+(?:[nrtbf"']|u[0-9a-f]{4}))*))\1[^\r\n]*$/i,
    );
    if (header >= 0) end = Math.min(end, header);
    // Never cut inside a \uXXXX escape: its last digit may be what a header boundary follows.
    const partial = text.slice(0, end).search(/(?<!\\)\\+u[0-9a-f]{0,3}$/i);
    if (partial >= 0) end = partial;
    if (end > 0 && text[end - 1] === "\\") end--;
    if (end === 0) return;
    const emitted = end === text.length ? redacted : safe(text.slice(0, end));
    // A held prefix can overlap a complete secret. Keep the whole buffer if splitting
    // would undo any redaction, rather than emitting either side of that match.
    if (emitted + safe(text.slice(end)) !== redacted) return;
    pending[stream] = pending[stream].slice(end);
    opts.onOutput(stream, emitted);
  };
  return {
    push,
    finish: () => {
      if (finished) return;
      finished = true;
      for (const stream of ["stdout", "stderr"] as const) {
        const text = pending[stream];
        pending[stream] = "";
        if (text) opts.onOutput?.(stream, opts.signal?.aborted ? cancelledSnapshot(text) : safe(text));
      }
    },
  };
}

export interface Exec {
  runJSON<T = unknown>(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult<T>>;
  runText(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult<string>>;
}

export interface ExecOutput {
  stdout: string;
  stderr: string;
  exit: number | null;
  error?: string;
}

export type ExecRunner = (cmd: string, args: string[], opts: ExecOptions) => Promise<ExecOutput>;

export function textResult(output: ExecOutput, opts: ExecOptions): ExecResult<string> {
  if (output.error !== undefined) return { ok: false, error: output.error, code: output.exit };
  if (output.exit !== 0 && !(opts.acceptNonZeroExit && output.exit !== null)) {
    const reason = output.stderr.split("\n").map((line) => line.trim()).find(Boolean);
    return { ok: false, error: (reason ?? `exit ${output.exit}`).slice(0, 200), code: output.exit };
  }
  // An accepted failure keeps its stderr: it is where gh names the HTTP status.
  return {
    ok: true, data: output.stdout, exitCode: output.exit,
    ...(output.exit !== 0 && output.stderr ? { stderr: output.stderr } : {}),
  };
}

export function jsonResult<T>(result: ExecResult<string>): ExecResult<T> {
  if (!result.ok) return result;
  const start = result.data.search(/[[{]/);
  if (start < 0) return { ok: false, error: "no JSON found in output", code: null };
  try {
    return { ok: true, data: JSON.parse(result.data.slice(start)) as T, exitCode: result.exitCode };
  } catch {
    // SyntaxError messages can quote stdout, including truncated credentials.
    return { ok: false, error: "invalid JSON: output could not be parsed", code: null };
  }
}
