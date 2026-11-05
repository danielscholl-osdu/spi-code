// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { createContext } from "../../src/context.js";
import { ReplayExec } from "../../src/exec/index.js";
import { type Exec, type ExecOptions, execRedactor } from "../../src/exec/port.js";
import type { ExecLogEntry } from "../../src/exec/recording.js";
import { AREAS, type Facts } from "../../src/facts.js";
import { GraphqlBudget } from "../../src/forge.js";
import { createSweeper } from "../../src/sweep/areas.js";

type Rate = { cost: number; remaining: number; resetAt: string };

// A recorded public sweep (scripts/record-sweep.ts): committed under fixtures/exec/sweep-<date>/
// once decision D2 allows it, kept under fixtures/exec/local/ until then, or named by
// SPICODE_SWEEP_LOG (the directory or its exec.jsonl).
const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const FIXTURES = join(ROOT, "fixtures", "exec");

function newestSweep(): string | undefined {
  const named = process.env.SPICODE_SWEEP_LOG;
  if (named) return named.endsWith(".jsonl") ? dirname(named) : named;
  const found = [FIXTURES, join(FIXTURES, "local")].flatMap((dir) =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => /^sweep-\d{4}-\d{2}-\d{2}$/.test(name))
          .map((name) => ({ name, dir: join(dir, name), committed: dir === FIXTURES }))
      : [],
  );
  found.sort((a, b) => b.name.localeCompare(a.name) || Number(b.committed) - Number(a.committed));
  return found[0]?.dir;
}

const sweep = newestSweep();

const factsSchema = z.custom<Facts>(
  (value) => !!value && typeof value === "object" && AREAS.every((area) => area in value),
);

function key(cmd: string, args: readonly string[], stdin: string | null): string {
  return JSON.stringify([cmd, args, stdin]);
}

function result(entry: ExecLogEntry): string {
  return JSON.stringify([entry.stdout, entry.stderr, entry.exit, entry.error ?? null]);
}

/** Core's ReplayExec, one per distinct call. The sweep reads areas concurrently, so the
 * recorded order across calls is timing; the order of one call's answers is not. A call
 * recorded more than once with the same answer each time is one read: the lifecycle reader
 * caches a run's declaration by commit only after reading it, so runs of two workflows at
 * one commit read it once or twice depending on which finishes first. */
class SweepReplay implements Exec {
  private readonly calls = new Map<string, { lines: string[]; exec: ReplayExec; served: number }>();
  readonly unexpected: string[] = [];

  constructor(jsonl: string) {
    const lines = new Map<string, string[]>();
    for (const line of jsonl.split("\n").filter((l) => l.trim())) {
      const entry = JSON.parse(line) as ExecLogEntry;
      const id = key(entry.cmd, entry.args, entry.stdin);
      lines.set(id, [...(lines.get(id) ?? []), line]);
    }
    for (const [id, recorded] of lines) {
      const answers = new Set(recorded.map((line) => result(JSON.parse(line) as ExecLogEntry)));
      const kept = answers.size === 1 ? recorded.slice(0, 1) : recorded;
      this.calls.set(id, { lines: kept, exec: new ReplayExec(kept.join("\n")), served: 0 });
    }
  }

  private next(cmd: string, args: string[], opts: ExecOptions): ReplayExec {
    const safe = execRedactor(opts);
    const id = key(safe(cmd), args.map(safe), opts.stdin === undefined ? null : safe(opts.stdin));
    const call = this.calls.get(id);
    if (!call) {
      this.unexpected.push(id.slice(0, 300));
      throw new Error(`Unexpected exec call: ${id.slice(0, 300)}`);
    }
    call.served++;
    if (call.lines.length === 1 && call.served > 1) return new ReplayExec(call.lines[0] as string);
    if (call.served > call.lines.length)
      this.unexpected.push(`more than recorded: ${id.slice(0, 300)}`);
    return call.exec;
  }

  runText(cmd: string, args: string[], opts: ExecOptions = {}) {
    return this.next(cmd, args, opts).runText(cmd, args, opts);
  }

  runJSON<T = unknown>(cmd: string, args: string[], opts: ExecOptions = {}) {
    return this.next(cmd, args, opts).runJSON<T>(cmd, args, opts);
  }

  get served(): number {
    return [...this.calls.values()].reduce((sum, call) => sum + call.served, 0);
  }

  assertExhausted(): void {
    for (const call of this.calls.values()) call.exec.assertExhausted();
  }
}

/** Splits what the sweep's account charged into GitHub's reported costs and the reservations
 * of calls that reported none (a failed or fenced call keeps its reservation charged). */
class BudgetLedger extends GraphqlBudget {
  reported = 0;
  unpriced = { calls: 0, reserved: 0 };

  override run<T>(estimate: number, call: () => Promise<{ value: T; rate?: Rate }>) {
    return super.run(estimate, async () => {
      try {
        const value = await call();
        if (value.rate) this.reported += value.rate.cost;
        else
          this.unpriced = {
            calls: this.unpriced.calls + 1,
            reserved: this.unpriced.reserved + estimate,
          };
        return value;
      } catch (error) {
        this.unpriced = {
          calls: this.unpriced.calls + 1,
          reserved: this.unpriced.reserved + estimate,
        };
        throw error;
      }
    });
  }
}

function recordedCosts(entries: readonly ExecLogEntry[]) {
  let cost = 0;
  let unpriced = 0;
  for (const entry of entries) {
    if (entry.cmd !== "gh" || !entry.args.some((arg) => arg.startsWith("query="))) continue;
    try {
      const reported = JSON.parse(entry.stdout)?.data?.spicodeBudget?.cost;
      if (typeof reported === "number") cost += reported;
      else unpriced++;
    } catch {
      unpriced++;
    }
  }
  return { cost, unpriced };
}

/** Facts both sides read differently by design, each named with its reason. */
function comparable(facts: Record<string, unknown>, side: "core" | "rib") {
  const copy = structuredClone(facts) as {
    github: { data?: Record<string, unknown> };
    sweep: Record<string, unknown>;
  };
  // The rib reports GitHub's rate limit in Facts; core accounts it in the sweep's budget
  // account (cache.budget), which this test checks against the log on its own.
  if (side === "rib" && copy.github.data) delete copy.github.data.rate;
  // How many calls a sweep makes: core pages lists in full, reads releases and pins, and
  // counts each read; the rib reads first pages. Core's count is checked against the log.
  delete copy.sweep.calls;
  return copy;
}

test.skipIf(!sweep)(
  sweep
    ? `a recorded public sweep replays through core to the rib's Facts (${relative(ROOT, sweep)})`
    : "a recorded public sweep replays through core to the rib's Facts " +
        "(skipped: no fixtures/exec/sweep-*/ or fixtures/exec/local/sweep-*/; run bun scripts/record-sweep.ts " +
        "or set SPICODE_SWEEP_LOG)",
  async () => {
    const dir = sweep as string;
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as {
      recordedAt: string;
      fleetFiles: { services: string };
    };
    const jsonl = readFileSync(join(dir, "exec.jsonl"), "utf8");
    const entries = jsonl
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as ExecLogEntry);
    const rib = JSON.parse(readFileSync(join(dir, "rib-facts.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const now = new Date(meta.recordedAt);
    const exec = new SweepReplay(jsonl);
    const budget = new BudgetLedger({ now: () => now });
    const sweeper = createSweeper({
      ctx: createContext({ clock: { now: () => now } }),
      exec,
      budget,
      persist: { load: async () => undefined, save: async () => {} },
      fleetFiles: meta.fleetFiles,
      readFile: (path) => readFileSync(join(dir, path), "utf8"),
      factsSchema,
    });

    await sweeper.sweep({ force: true });

    expect(exec.unexpected).toEqual([]);
    exec.assertExhausted();
    expect(sweeper.facts.sweep?.calls).toBe(exec.served);
    expect(comparable(sweeper.facts as unknown as Record<string, unknown>, "core")).toEqual(
      comparable(rib, "rib"),
    );
    const recorded = recordedCosts(entries);
    expect(budget.reported).toBe(recorded.cost);
    expect(budget.unpriced.calls).toBe(recorded.unpriced);
    expect(sweeper.cache.budget.cost).toBe(recorded.cost + budget.unpriced.reserved);
  },
);
