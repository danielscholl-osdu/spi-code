// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { DECLARATION_PATH } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { ReplayExec } from "../../src/exec/index.js";
import { type Exec, type ExecOptions, execRedactor } from "../../src/exec/port.js";
import type { ExecLogEntry } from "../../src/exec/recording.js";
import { redact } from "../../src/exec/redact.js";
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

// The lifecycle reader caches a run's declaration by commit only after its read returns, and
// reads two workflows' runs at once (spicode-t1k.109), so two runs at one commit read the stack's
// declaration once or twice depending on which returns first. Only that read, with one answer
// recorded, may be served a number of times other than recorded: once to DECLARATION_RACE times.
const DECLARATION_READ = new RegExp(
  `^repos/[^/]+/[^/]+/contents/${DECLARATION_PATH.replace(/[.]/g, "\\.")}\\?ref=[0-9a-f]{40}$`,
);
const DECLARATION_RACE = 2;

function raced(cmd: string, args: readonly string[]): boolean {
  return cmd === "gh" && args[0] === "api" && DECLARATION_READ.test(args[1] ?? "");
}

/** Core's ReplayExec, one per distinct call. The sweep reads areas concurrently, so the
 * recorded order across calls is timing; the order of one call's answers is not. Each recorded
 * entry is served once and must be served, except the declaration race above. */
class SweepReplay implements Exec {
  private readonly calls = new Map<
    string,
    { lines: string[]; exec: ReplayExec; served: number; min: number; max: number }
  >();
  readonly unexpected: string[] = [];

  constructor(jsonl: string) {
    const lines = new Map<string, string[]>();
    for (const line of jsonl.split("\n").filter((l) => l.trim())) {
      const entry = JSON.parse(line) as ExecLogEntry;
      const id = key(entry.cmd, entry.args, entry.stdin);
      lines.set(id, [...(lines.get(id) ?? []), line]);
    }
    for (const [id, recorded] of lines) {
      const first = JSON.parse(recorded[0] as string) as ExecLogEntry;
      const answers = new Set(recorded.map((line) => result(JSON.parse(line) as ExecLogEntry)));
      const race =
        raced(first.cmd, first.args) && answers.size === 1 && recorded.length <= DECLARATION_RACE;
      const kept = race ? recorded.slice(0, 1) : recorded;
      this.calls.set(id, {
        lines: kept,
        exec: new ReplayExec(kept.join("\n")),
        served: 0,
        min: kept.length,
        max: race ? DECLARATION_RACE : kept.length,
      });
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
    if (call.served >= call.max) {
      this.unexpected.push(`more often than recorded: ${id.slice(0, 300)}`);
      throw new Error(`Exec call made more often than recorded (${call.max}): ${id.slice(0, 300)}`);
    }
    call.served++;
    return call.served > call.lines.length ? new ReplayExec(call.lines[0] as string) : call.exec;
  }

  async runText(cmd: string, args: string[], opts: ExecOptions = {}) {
    return this.next(cmd, args, opts).runText(cmd, args, opts);
  }

  async runJSON<T = unknown>(cmd: string, args: string[], opts: ExecOptions = {}) {
    return this.next(cmd, args, opts).runJSON<T>(cmd, args, opts);
  }

  get served(): number {
    return [...this.calls.values()].reduce((sum, call) => sum + call.served, 0);
  }

  /** The declaration reads served other than as recorded, for the report. */
  get raced(): number {
    return [...this.calls.values()].filter(
      (call) => call.max > call.min && call.served !== call.lines.length,
    ).length;
  }

  assertExhausted(): void {
    for (const call of this.calls.values()) call.exec.assertExhausted();
  }
}

describe("SweepReplay", () => {
  const STACK = "Azure/osdu-spi-stack";
  const entry = (args: string[], stdout = "{}") =>
    JSON.stringify({ cmd: "gh", args, stdin: null, stdout, stderr: "", exit: 0, ms: 1 });
  const log = (...lines: string[]) => lines.join("\n");
  const call = (exec: Exec, args: string[]) => exec.runText("gh", args);
  const rate = ["api", "rate_limit"];
  const declaration = ["api", `repos/${STACK}/contents/${DECLARATION_PATH}?ref=${"a".repeat(40)}`];

  test("serves each recorded answer once", async () => {
    const exec = new SweepReplay(log(entry(rate)));
    await call(exec, rate);
    await expect(call(exec, rate)).rejects.toThrow(/more often than recorded/);
    expect(exec.unexpected).toHaveLength(1);
  });

  test("a call recorded twice with the same answer must be made twice", async () => {
    const exec = new SweepReplay(log(entry(rate), entry(rate)));
    await call(exec, rate);
    expect(() => exec.assertExhausted()).toThrow(/Unconsumed exec entry/);
    await call(exec, rate);
    exec.assertExhausted();
  });

  test("a lifecycle declaration read at one commit may run once or twice, never more", async () => {
    const once = new SweepReplay(log(entry(declaration)));
    expect(() => once.assertExhausted()).toThrow(/Unconsumed exec entry/);
    await call(once, declaration);
    await call(once, declaration);
    once.assertExhausted();
    await expect(call(once, declaration)).rejects.toThrow(/more often than recorded/);
    const twice = new SweepReplay(log(entry(declaration), entry(declaration)));
    await call(twice, declaration);
    twice.assertExhausted();
  });

  test("a lifecycle declaration read with differing answers is replayed strictly", async () => {
    const exec = new SweepReplay(log(entry(declaration, "{}"), entry(declaration, "[]")));
    await call(exec, declaration);
    expect(() => exec.assertExhausted()).toThrow(/Unconsumed exec entry/);
  });
});

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

type PortFacts = {
  radar?: {
    data?: {
      portRead?: { prs: number; commits: number };
      services?: Record<string, { forkPrs?: { state: string }[] }>;
    };
  };
};

// The rib reads one page of a fork's port PRs and, past it, leaves the fork out of forkPrs and
// portRead; core pages on (spicode-cp9).
const RIB_PORT_PAGE = 100;

/** The forks core read past the rib's page: forkPrs on core's side only, with more open or
 * merged PRs than one page holds. */
function pagedPastRib(core: PortFacts, rib: PortFacts): string[] {
  const ribServices = rib.radar?.data?.services ?? {};
  return Object.entries(core.radar?.data?.services ?? {}).flatMap(([id, service]) => {
    const prs = service.forkPrs;
    if (!prs || ribServices[id]?.forkPrs) return [];
    const open = prs.filter((pr) => pr.state === "open").length;
    return open > RIB_PORT_PAGE || prs.length - open > RIB_PORT_PAGE ? [id] : [];
  });
}

/** Facts both sides read differently by design, each named with its reason. */
function comparable(facts: Record<string, unknown>, side: "core" | "rib", paged: string[] = []) {
  const copy = structuredClone(facts) as {
    github: { data?: Record<string, unknown> };
    sweep: Record<string, unknown>;
  } & PortFacts;
  // A fork core paged past the rib's page is compared by count, with portRead, on its own.
  for (const id of paged) {
    const service = copy.radar?.data?.services?.[id];
    if (side === "core" && service) delete service.forkPrs;
  }
  if (paged.length) delete copy.radar?.data?.portRead;
  // The rib reports GitHub's rate limit in Facts; core accounts it in the sweep's budget
  // account (cache.budget), which this test checks against the log on its own.
  if (side === "rib" && copy.github.data) delete copy.github.data.rate;
  // How many calls a sweep makes: core pages lists in full, reads releases and pins, and
  // counts each read; the rib reads first pages. Core's count is checked against the log.
  delete copy.sweep.calls;
  return copy;
}

/** Core's Facts from the live sweep that wrote the log, as the replay must read them: the log
 * holds redacted output, so live strings are redacted the same way, and the live count of calls
 * is the log's length, which the replay's own count is checked against with the race allowed. */
function asLogged(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(asLogged);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, asLogged(v)]));
  return value;
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
    > &
      PortFacts;
    const live = asLogged(JSON.parse(readFileSync(join(dir, "core-facts.json"), "utf8"))) as Record<
      string,
      unknown
    > & { sweep: { calls?: number } };
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
    expect(live.sweep.calls).toBe(entries.length);
    expect(exec.served).toBeGreaterThanOrEqual(entries.length - exec.raced);
    expect(exec.served).toBeLessThanOrEqual(entries.length + exec.raced);
    expect(comparable(sweeper.facts as unknown as Record<string, unknown>, "core")).toEqual(
      comparable(live, "core"),
    );
    const core = sweeper.facts as unknown as Record<string, unknown> & PortFacts;
    const paged = pagedPastRib(core, rib);
    expect(comparable(core, "core", paged)).toEqual(comparable(rib, "rib", paged));
    if (paged.length) {
      const read = (facts: PortFacts) => facts.radar?.data?.portRead ?? { prs: 0, commits: 0 };
      const extra = paged.reduce(
        (sum, id) => sum + (core.radar?.data?.services?.[id]?.forkPrs?.length ?? 0),
        0,
      );
      expect(read(core).prs).toBe(read(rib).prs + extra);
      expect(read(core).commits).toBeGreaterThan(read(rib).commits);
    }
    const recorded = recordedCosts(entries);
    expect(budget.reported).toBe(recorded.cost);
    expect(budget.unpriced.calls).toBe(recorded.unpriced);
    expect(sweeper.cache.budget.cost).toBe(recorded.cost + budget.unpriced.reserved);
  },
);
