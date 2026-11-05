// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { REDACTED, redact } from "./redact.js";

export type ExecResult<T> =
  | { ok: true; data: T; exitCode?: number | null }
  | { ok: false; error: string; code: number | null };

export interface ExecOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
  cwd?: string;
  acceptNonZeroExit?: boolean;
  stdin?: string;
  signal?: AbortSignal;
  /** Redacted live output; potential credential fragments may be held until complete. */
  onOutput?: (stream: "stdout" | "stderr", text: string) => void;
}

export function execRedactor(opts: ExecOptions, env: Record<string, string> = {}) {
  const secrets = { ...env, ...opts.env };
  const input = opts.stdin?.trim();
  return (text: string): string =>
    redact(input ? text.split(input).join(REDACTED) : text, secrets);
}

export function execOutputDelivery(opts: ExecOptions, env: Record<string, string> = {}) {
  const safe = execRedactor(opts, env);
  const secrets = Object.entries({ ...env, ...opts.env })
    .filter(([name, value]) => /TOKEN/i.test(name) && value.length >= 8)
    .map(([, value]) => value);
  if (opts.stdin?.trim()) secrets.push(opts.stdin.trim());
  const prefixes = ["gho_", "ghp_", "ghs_", "ghu_", "ghr_", "github_pat_", "glpat-", "authorization", "bearer"];
  const pending = { stdout: "", stderr: "" };
  const push = (stream: "stdout" | "stderr", chunk: string, final = false) => {
    if (!opts.onOutput || opts.signal?.aborted) return;
    pending[stream] += chunk;
    const text = pending[stream];
    let end = text.length;
    if (!final) {
      // Do not publish a suffix whose redaction can change when the next chunk arrives.
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
      const credential = text.search(/(?:gh[opsur]_|github_pat_|glpat-)[A-Za-z0-9_-]*$/);
      if (credential >= 0) end = Math.min(end, credential);
      const header = text.search(/(?:authorization|bearer)[^\r\n]*$/i);
      if (header >= 0) end = Math.min(end, header);
    }
    if (end === 0) return;
    pending[stream] = pending[stream].slice(end);
    opts.onOutput(stream, safe(text.slice(0, end)));
  };
  return {
    push,
    finish: () => {
      push("stdout", "", true);
      push("stderr", "", true);
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
  return { ok: true, data: output.stdout, exitCode: output.exit };
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
