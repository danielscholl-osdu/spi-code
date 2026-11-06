// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import {
  type Exec, type ExecOptions, type ExecOutput, type ExecRunner, execRedactor,
  execOutputDelivery, jsonResult, textResult,
} from "./port.js";

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
    if (opts.signal?.aborted) return textResult({ stdout: "", stderr: "", exit: null, error: "Command aborted." }, opts);
    const started = performance.now();
    const safe = execRedactor(opts, this.env);
    const call = {
      cmd: safe(cmd), args: args.map(safe),
      stdin: opts.stdin === undefined ? null : safe(opts.stdin),
    };
    const delivery = execOutputDelivery(opts, this.env);
    const streamed = new Set<string>();
    const terminal = new Set<string>();
    let finished = false;
    const output = this.capture(cmd, [...args], opts.onOutput
      ? { ...opts, onOutput: (stream, text, phase) => {
        if (finished || terminal.has(stream)) return;
        streamed.add(stream);
        if (phase === undefined) {
          delivery.push(stream, text);
        } else if (phase === "terminal" || !opts.signal?.aborted) {
          if (phase === "terminal") terminal.add(stream);
          opts.onOutput?.(stream, text, phase);
        }
      } } : opts).then((result) => {
        finished = true;
        if (!streamed.has("stdout")) delivery.push("stdout", result.stdout);
        if (!streamed.has("stderr")) delivery.push("stderr", result.stderr);
        delivery.finish(result.error === undefined ? undefined : "interrupted");
        return result;
      }).catch((failure: unknown): ExecOutput => ({
        stdout: "", stderr: "", exit: null,
        error: safe(failure instanceof Error ? failure.message : String(failure)),
      }));
    const previous = this.written;
    const written = (async () => {
      const result = await output;
      const ms = performance.now() - started;
      // A cancelled or failed run records the snapshot it delivered, never a held secret prefix.
      const text = opts.signal?.aborted || result.error !== undefined ? delivery.snapshot : safe;
      const entry: ExecLogEntry = {
        ...call, stdout: text(result.stdout), stderr: text(result.stderr), exit: result.exit, ms,
        ...(result.error === undefined ? {} : { error: safe(result.error) }),
      };
      await previous;
      await this.write(`${JSON.stringify(entry)}\n`);
    })();
    // A failed write rejects only its own call; later calls still record.
    this.written = written.catch(() => {});
    await written;
    const result = await output;
    return textResult({ ...result, stderr: safe(result.stderr),
      ...(result.error === undefined ? {} : { error: safe(result.error) }) }, opts);
  }

  async runJSON<T = unknown>(cmd: string, args: string[], opts: ExecOptions = {}) {
    return jsonResult<T>(await this.runText(cmd, args, opts));
  }

  private async capture(cmd: string, args: string[], opts: ExecOptions): Promise<ExecOutput> {
    try {
      const output = await this.runner(cmd, args, opts);
      return opts.signal?.aborted ? { ...output, error: "Command aborted." } : output;
    } catch (error) {
      return {
        stdout: "", stderr: "", exit: null,
        error: opts.signal?.aborted ? "Command aborted." :
          error instanceof Error ? error.message : String(error),
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
    if (opts.signal?.aborted) return textResult({ stdout: "", stderr: "", exit: null, error: "Command aborted." }, opts);
    const safe = execRedactor(opts, this.env);
    const entry = this.entries[this.cursor];
    const actual = {
      cmd: safe(cmd), args: args.map(safe),
      stdin: opts.stdin === undefined ? null : safe(opts.stdin),
    };
    if (!entry || entry.cmd !== actual.cmd ||
      JSON.stringify(entry.args) !== JSON.stringify(actual.args) || entry.stdin !== actual.stdin) {
      const expected = entry ? safe(`${entry.cmd} ${JSON.stringify(entry.args)}`) : "end of log";
      throw new Error(
        `Unexpected exec call: ${actual.cmd} ${JSON.stringify(actual.args)}; expected ${expected}`,
      );
    }
    this.cursor += 1;
    const delivery = execOutputDelivery(opts, this.env);
    delivery.push("stdout", entry.stdout);
    delivery.push("stderr", entry.stderr);
    delivery.finish();
    if (opts.signal?.aborted) return textResult({ ...entry, error: "Command aborted." }, opts);
    return textResult({ ...entry, stderr: safe(entry.stderr),
      ...(entry.error === undefined ? {} : { error: safe(entry.error) }) }, opts);
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
