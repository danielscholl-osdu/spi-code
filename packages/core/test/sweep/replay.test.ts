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

// The recorder writes private/redacted-<n> for each repository that is not public: as a path
// (/ or %2F), as GraphQL's owner and name, or as redacted-<n> for the name alone.
const NAME = String.raw`[A-Za-z0-9_.-]+?`;
const PLACEHOLDERS = new RegExp(
  [
    String.raw`owner:\s*\\?"private\\?"\s*,\s*name:\s*\\?"redacted-(\d+)\\?"`,
    String.raw`name:\s*\\?"redacted-(\d+)\\?"\s*,\s*owner:\s*\\?"private\\?"`,
    String.raw`private(\/|%2F)redacted-(\d+)`,
    String.raw`redacted-(\d+)`,
  ].join("|"),
  "gi",
);
const escapeText = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Slot = { n: string; kind: "owner" | "name" | "path" | "part"; separator?: string };

/** A recorded argument as a pattern a live argument matches, naming what each placeholder
 * stands for; undefined when it holds none. A GitHub repository has two segments, a GitLab
 * project two or more. */
function placeholderPattern(
  cmd: string,
  recorded: string,
): { pattern: RegExp; slots: Slot[] } | undefined {
  const slots: Slot[] = [];
  let source = "";
  let at = 0;
  for (const match of recorded.matchAll(PLACEHOLDERS)) {
    source += escapeText(recorded.slice(at, match.index));
    at = (match.index as number) + match[0].length;
    const [text, ownerFirst, nameFirst, separator, path, part] = match;
    const pair = ownerFirst ?? nameFirst;
    if (pair) {
      const pieces = text.split(/(private|redacted-\d+)/i);
      source += pieces
        .map((piece) => {
          if (/^private$/i.test(piece)) {
            slots.push({ n: pair, kind: "owner" });
            return `(${NAME})`;
          }
          if (/^redacted-\d+$/i.test(piece)) {
            slots.push({ n: pair, kind: "name" });
            return `(${NAME})`;
          }
          return escapeText(piece);
        })
        .join("");
    } else if (path) {
      slots.push({ n: path, kind: "path", separator });
      const sep = escapeText(separator as string);
      source += `(${NAME}(?:${sep}${NAME})${cmd === "gh" ? "" : "+"})`;
    } else {
      slots.push({ n: part as string, kind: "part" });
      source += `(${NAME})`;
    }
  }
  if (!slots.length) return undefined;
  source += escapeText(recorded.slice(at));
  return { pattern: new RegExp(`^${source}$`), slots };
}

/** Core's ReplayExec, one per distinct call. The sweep reads areas concurrently, so the
 * recorded order across calls is timing; the order of one call's answers is not. Each recorded
 * entry is served once and must be served, except the declaration race above. */
class SweepReplay implements Exec {
  private readonly calls = new Map<
    string,
    { lines: string[]; exec: ReplayExec; served: number; min: number; max: number }
  >();
  // What each placeholder stands for, one private repository each, once a call has bound it.
  private readonly bound = new Map<string, string>();
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

  /** The recorded call, with placeholders, that this live call is, binding each placeholder to
   * the one repository it stands for across the whole replay. */
  private unify(cmd: string, args: readonly string[], stdin: string | null): string | undefined {
    for (const [id, call] of this.calls) {
      if (call.served >= call.max) continue;
      const [recordedCmd, recordedArgs, recordedStdin] = JSON.parse(id) as [
        string,
        string[],
        string | null,
      ];
      if (recordedCmd !== cmd || recordedArgs.length !== args.length || recordedStdin !== stdin)
        continue;
      const names = new Map<
        string,
        { full?: string; owner?: string; name?: string; part?: string }
      >();
      let same = true;
      let placeholders = 0;
      recordedArgs.forEach((recorded, i) => {
        if (!same) return;
        const live = args[i] as string;
        const shape = placeholderPattern(cmd, recorded);
        if (!shape) {
          same = recorded === live;
          return;
        }
        const match = shape.pattern.exec(live);
        if (!match) {
          same = false;
          return;
        }
        shape.slots.forEach((slot, j) => {
          placeholders++;
          const value = (match[j + 1] as string).toLowerCase();
          const name = names.get(slot.n) ?? {};
          const set = (field: "full" | "owner" | "name" | "part", to: string) => {
            if (name[field] !== undefined && name[field] !== to) same = false;
            name[field] = to;
          };
          if (slot.kind === "path")
            set("full", value.split((slot.separator as string).toLowerCase()).join("/"));
          else set(slot.kind, value);
          names.set(slot.n, name);
        });
      });
      if (!same || !placeholders) continue;
      const bindings: [string, string | undefined, string][] = [];
      for (const [n, name] of names) {
        const pair = name.owner && name.name ? `${name.owner}/${name.name}` : undefined;
        const full = name.full ?? pair ?? this.bound.get(n);
        if (name.full && pair && name.full !== pair) same = false;
        const last = full?.split("/").at(-1);
        for (const part of [name.name, name.part]) if (part && last && part !== last) same = false;
        if (!full && !this.bound.has(n)) same = false;
        bindings.push([n, full, last ?? ""]);
      }
      for (const [n, full] of bindings) {
        if (!full) continue;
        const was = this.bound.get(n);
        if (was !== undefined && was !== full) same = false;
        for (const [other, value] of this.bound) if (other !== n && value === full) same = false;
      }
      if (!same) continue;
      for (const [n, full] of bindings) if (full) this.bound.set(n, full);
      return id;
    }
    return undefined;
  }

  private next(
    cmd: string,
    args: string[],
    opts: ExecOptions,
  ): { exec: ReplayExec; args: string[] } {
    const safe = execRedactor(opts);
    const stdin = opts.stdin === undefined ? null : safe(opts.stdin);
    let id = key(safe(cmd), args.map(safe), stdin);
    let call = this.calls.get(id);
    if (!call) {
      const unified = this.unify(safe(cmd), args.map(safe), stdin);
      if (unified) {
        id = unified;
        call = this.calls.get(id);
      }
    }
    if (!call) {
      this.unexpected.push(id.slice(0, 300));
      throw new Error(`Unexpected exec call: ${id.slice(0, 300)}`);
    }
    if (call.served >= call.max) {
      this.unexpected.push(`more often than recorded: ${id.slice(0, 300)}`);
      throw new Error(`Exec call made more often than recorded (${call.max}): ${id.slice(0, 300)}`);
    }
    call.served++;
    const recorded = (JSON.parse(id) as [string, string[]])[1];
    const exec =
      call.served > call.lines.length ? new ReplayExec(call.lines[0] as string) : call.exec;
    return { exec, args: recorded };
  }

  async runText(cmd: string, args: string[], opts: ExecOptions = {}) {
    const { exec, args: recorded } = this.next(cmd, args, opts);
    return exec.runText(cmd, recorded, opts);
  }

  async runJSON<T = unknown>(cmd: string, args: string[], opts: ExecOptions = {}) {
    const { exec, args: recorded } = this.next(cmd, args, opts);
    return exec.runJSON<T>(cmd, recorded, opts);
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

  test("serves a recorded placeholder as the one private repository it stands for", async () => {
    const releases = (repo: string) => ["api", `repos/${repo}/releases`];
    const graphql = (owner: string, name: string) => [
      "api",
      "graphql",
      "-f",
      `query=query { r: repository(owner: "${owner}", name: "${name}") { id } }`,
    ];
    const exec = new SweepReplay(
      log(entry(releases("private/redacted-1")), entry(graphql("private", "redacted-1"))),
    );
    await call(exec, releases("acme/vault"));
    await expect(call(exec, graphql("acme", "other"))).rejects.toThrow(/Unexpected exec call/);
    await call(exec, graphql("acme", "vault"));
    exec.assertExhausted();
    const other = new SweepReplay(log(entry(releases("private/redacted-1"))));
    await expect(call(other, releases("acme/vault/extra"))).rejects.toThrow(/Unexpected/);
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
      services?: Record<string, { forkPrs?: { state: string; url?: string }[] }>;
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

type SearchNode = {
  number?: number;
  commits?: {
    totalCount: number;
    pageInfo?: { hasNextPage?: boolean };
    nodes?: unknown[];
  };
};

function queryOf(entry: ExecLogEntry): string {
  return entry.args.find((arg) => arg.startsWith("query="))?.slice("query=".length) ?? "";
}

function searchData(entry: ExecLogEntry): Record<string, { nodes?: (SearchNode | null)[] } | null> {
  try {
    return JSON.parse(entry.stdout)?.data ?? {};
  } catch {
    return {};
  }
}

/** What core read of these forks' port PRs, from the log: each PR node its searches returned
 * (the batch's port_o/port_m aliases for the fork and its port_page pages), with the commit
 * messages it counted for each, inline or, for a node whose commits were cut, from the REST
 * pages it then read. */
function portReadOf(entries: readonly ExecLogEntry[], repos: readonly string[]) {
  const read = { prs: 0, commits: 0 };
  const rest = (repo: string, number: number) =>
    entries.find(
      (entry) =>
        entry.cmd === "gh" &&
        entry.exit === 0 &&
        entry.args.some((arg) => arg.startsWith(`repos/${repo}/pulls/${number}/commits?`)),
    );
  for (const repo of repos) {
    const search = (alias: string) =>
      new RegExp(
        `\\b(${alias}): search\\(query: "repo:${repo.replace(/[.]/g, "\\.")} is:pr[ "]`,
        "g",
      );
    for (const entry of entries) {
      if (entry.cmd !== "gh" || entry.exit !== 0) continue;
      const query = queryOf(entry);
      const aliases = [...query.matchAll(search("port_[om]\\d+|port_page"))].map((m) => m[1]);
      for (const alias of aliases) {
        for (const node of searchData(entry)[alias as string]?.nodes ?? []) {
          if (!node) continue;
          read.prs++;
          const inline = node.commits?.nodes?.length ?? 0;
          const whole =
            node.commits?.nodes &&
            node.commits.pageInfo?.hasNextPage === false &&
            node.commits.totalCount <= inline;
          const paged = whole ? undefined : rest(repo, node.number ?? 0);
          read.commits += paged ? paged.stdout.split("\n").filter((l) => l.trim()).length : inline;
        }
      }
    }
  }
  return read;
}

/** A fork core paged past the rib's page adds exactly what core read of it to portRead. */
function expectPagedPortRead(
  core: PortFacts,
  rib: PortFacts,
  paged: readonly string[],
  entries: readonly ExecLogEntry[],
): void {
  const read = (facts: PortFacts) => facts.radar?.data?.portRead ?? { prs: 0, commits: 0 };
  const services = core.radar?.data?.services ?? {};
  const prs = paged.flatMap((id) => services[id]?.forkPrs ?? []);
  const repos = [
    ...new Set(
      prs.flatMap((pr) => /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(pr.url ?? "")?.[1] ?? []),
    ),
  ];
  const delta = portReadOf(entries, repos);
  expect(delta.prs).toBe(prs.length);
  expect(read(core)).toEqual({
    prs: read(rib).prs + delta.prs,
    commits: read(rib).commits + delta.commits,
  });
}

describe("paged port reads", () => {
  const node = (number: number, commits: number, cut = false): SearchNode => ({
    number,
    commits: {
      totalCount: cut ? 60 : commits,
      pageInfo: { hasNextPage: cut },
      nodes: Array.from({ length: commits }, () => ({ commit: { message: "m" } })),
    },
  });
  const search = (alias: string, query: string) =>
    `${alias}: search(query: ${JSON.stringify(query)}, type: ISSUE, first: 100) { nodes }`;
  const gh = (args: string[], stdout: string): ExecLogEntry => ({
    cmd: "gh",
    args,
    stdin: null,
    stdout,
    stderr: "",
    exit: 0,
    ms: 1,
  });
  const repo = "acme/big";
  const entries = [
    gh(
      [
        "api",
        "graphql",
        "-f",
        `query=query { ${search("port_o0", "repo:acme/small is:pr is:open")} ${search("port_o1", `repo:${repo} is:pr is:open`)} ${search("port_m1", `repo:${repo} is:pr is:merged merged:>=2026-01-01`)} }`,
      ],
      JSON.stringify({
        data: {
          port_o0: { nodes: [node(9, 7)] },
          port_o1: { nodes: [node(1, 2)] },
          port_m1: { nodes: Array.from({ length: 100 }, (_, i) => node(i + 10, 1)) },
        },
      }),
    ),
    gh(
      [
        "api",
        "graphql",
        "-f",
        `query=query { ${search("port_page", `repo:${repo} is:pr is:merged`)} }`,
      ],
      JSON.stringify({ data: { port_page: { nodes: [node(2, 3), node(3, 50, true)] } } }),
    ),
    gh(["api", `repos/${repo}/pulls/3/commits?per_page=100`, "--paginate"], '"a"\n"b"\n"c"\n"d"\n'),
  ];
  const facts = (prs: number, commits: number, forkPrs?: number): PortFacts => ({
    radar: {
      data: {
        portRead: { prs, commits },
        services: forkPrs
          ? {
              big: {
                forkPrs: Array.from({ length: forkPrs }, (_, i) => ({
                  state: "merged",
                  url: `https://github.com/${repo}/pull/${i + 1}`,
                })),
              },
            }
          : {},
      },
    },
  });

  test("reads the paged fork's PRs and commits from the log", () => {
    expect(portReadOf(entries, [repo])).toEqual({ prs: 103, commits: 2 + 100 + 3 + 4 });
  });

  test("passes a rib portRead short by exactly that read", () => {
    expectPagedPortRead(facts(110, 119, 103), facts(7, 10), ["big"], entries);
  });

  test.each([0, 9, 11, 119])(
    "fails a rib portRead of %i commits, not exactly short by it",
    (commits) => {
      expect(() =>
        expectPagedPortRead(facts(110, 119, 103), facts(7, commits), ["big"], entries),
      ).toThrow();
    },
  );

  test.skipIf(!sweep)("fails the recorded rib portRead with any other commit count", () => {
    const dir = sweep as string;
    const load = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8")) as PortFacts;
    const core = load("core-facts.json");
    const rib = load("rib-facts.json");
    const logged = readFileSync(join(dir, "exec.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as ExecLogEntry);
    const paged = pagedPastRib(core, rib);
    expect(paged.length).toBeGreaterThan(0);
    expectPagedPortRead(core, rib, paged, logged);
    const commits = rib.radar?.data?.portRead?.commits ?? 0;
    for (const wrong of [
      0,
      commits - 1,
      commits + 1,
      (core.radar?.data?.portRead?.commits ?? 0) - 3,
    ]) {
      const mutated = structuredClone(rib);
      if (mutated.radar?.data?.portRead) mutated.radar.data.portRead.commits = wrong;
      expect(() => expectPagedPortRead(core, mutated, paged, logged)).toThrow();
    }
  });
});

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
    if (paged.length) expectPagedPortRead(core, rib, paged, entries);
    const recorded = recordedCosts(entries);
    expect(budget.reported).toBe(recorded.cost);
    expect(budget.unpriced.calls).toBe(recorded.unpriced);
    expect(sweeper.cache.budget.cost).toBe(recorded.cost + budget.unpriced.reserved);
  },
);
