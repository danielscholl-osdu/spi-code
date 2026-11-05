// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import {
  type Exec, type ExecOptions, type ExecOutput, type ExecRunner, jsonResult, textResult,
} from "./port.js";
import { redact } from "./redact.js";

const entrySchema = z.object({
  cmd: z.string(), args: z.array(z.string()), stdin: z.string().nullable(),
  stdout: z.string(), stderr: z.string(), exit: z.number().int().nullable(),
  ms: z.number().nonnegative(), error: z.string().optional(),
}).strict();

export type ExecLogEntry = z.infer<typeof entrySchema>;
export type ExecLogWriter = (jsonl: string) => void | Promise<void>;

export class RecordingExec implements Exec {
  private written: Promise<void> = Promise.resolve();

  constructor(
    private readonly runner: ExecRunner,
    private readonly write: ExecLogWriter,
    private readonly env: Record<string, string> = {},
  ) {}

  async runText(cmd: string, args: string[], opts: ExecOptions = {}) {
    const started = performance.now();
    const env = { ...this.env, ...opts.env };
    const safe = (text: string) => redact(text, env);
    const call = {
      cmd: safe(cmd), args: args.map(safe),
      stdin: opts.stdin === undefined ? null : safe(opts.stdin),
    };
    const output = this.capture(cmd, [...args], opts);
    const previous = this.written;
    const written = (async () => {
      const result = await output;
      const ms = performance.now() - started;
      const entry: ExecLogEntry = {
        ...call, stdout: safe(result.stdout), stderr: safe(result.stderr), exit: result.exit, ms,
        ...(result.error === undefined ? {} : { error: safe(result.error) }),
      };
      await previous;
      await this.write(`${JSON.stringify(entry)}\n`);
    })();
    this.written = written;
    await written;
    return textResult(await output, opts);
  }

  async runJSON<T = unknown>(cmd: string, args: string[], opts: ExecOptions = {}) {
    return jsonResult<T>(await this.runText(cmd, args, opts));
  }

  private async capture(cmd: string, args: string[], opts: ExecOptions): Promise<ExecOutput> {
    try {
      return await this.runner(cmd, args, opts);
    } catch (error) {
      return {
        stdout: "", stderr: "", exit: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export class ReplayExec implements Exec {
  private readonly entries: ExecLogEntry[];
  private cursor = 0;

  constructor(jsonl: string, private readonly env: Record<string, string> = {}) {
    this.entries = jsonl.split("\n").filter((line) => line.trim())
      .map((line) => entrySchema.parse(JSON.parse(line)));
  }

  async runText(cmd: string, args: string[], opts: ExecOptions = {}) {
    const safe = (text: string) => redact(text, { ...this.env, ...opts.env });
    const entry = this.entries[this.cursor];
    const actual = {
      cmd: safe(cmd), args: args.map(safe),
      stdin: opts.stdin === undefined ? null : safe(opts.stdin),
    };
    if (!entry || entry.cmd !== actual.cmd ||
      JSON.stringify(entry.args) !== JSON.stringify(actual.args) || entry.stdin !== actual.stdin) {
      const expected = entry ? `${entry.cmd} ${JSON.stringify(entry.args)}` : "end of log";
      throw new Error(
        `Unexpected exec call: ${actual.cmd} ${JSON.stringify(actual.args)}; expected ${expected}`,
      );
    }
    this.cursor += 1;
    return textResult(entry, opts);
  }

  async runJSON<T = unknown>(cmd: string, args: string[], opts: ExecOptions = {}) {
    return jsonResult<T>(await this.runText(cmd, args, opts));
  }

  assertExhausted(): void {
    const entry = this.entries[this.cursor];
    if (entry) {
      throw new Error(
        `Unconsumed exec entry: ${entry.cmd} ${JSON.stringify(entry.args)} (${this.entries.length - this.cursor} remaining)`,
      );
    }
  }
}
