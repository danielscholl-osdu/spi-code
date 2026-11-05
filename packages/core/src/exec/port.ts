// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

export type ExecResult<T> =
  | { ok: true; data: T; exitCode?: number | null }
  | { ok: false; error: string; code: number | null };

export interface ExecOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
  cwd?: string;
  acceptNonZeroExit?: boolean;
  stdin?: string;
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `invalid JSON: ${message}`.slice(0, 200), code: null };
  }
}
