// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { type Clock, systemClock } from "./clock.js";
import { GITLAB_HOST } from "./config.js";
import type { Exec } from "./exec/index.js";

export class ForgeError extends Error {
  constructor(message: string, readonly code: number | null) {
    super(message);
  }
}

export interface GqlError {
  type?: string;
  path?: (string | number)[];
  message: string;
}

export interface CallCounter {
  calls: number;
}

const rateSchema = z.object({
  cost: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  resetAt: z.iso.datetime({ offset: true }),
});
type Rate = z.infer<typeof rateSchema>;
export interface GraphqlBudgetSnapshot {
  remaining: number | null;
  resetAt: string | null;
  spent: number;
  calls: number;
}

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class GraphqlBudget {
  private queue: Promise<void> = Promise.resolve();
  private inFlight = 0;
  private probe: Promise<void> | null = null;
  private state: GraphqlBudgetSnapshot = { remaining: null, resetAt: null, spent: 0, calls: 0 };

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly sleep: Sleep = realSleep,
  ) {}

  snapshot(): GraphqlBudgetSnapshot {
    return { ...this.state };
  }

  // Reservations are serialised; the calls they pay for run concurrently once the
  // remaining budget is known. While it is unknown, one call probes it and the rest wait.
  async run<T>(estimate: number, call: () => Promise<{ value: T; rate?: Rate }>): Promise<T> {
    if (!Number.isSafeInteger(estimate) || estimate < 1) {
      throw new ForgeError("GraphQL cost estimate must be a positive integer", null);
    }
    const previous = this.queue;
    let release = () => {};
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    let settle: (() => void) | undefined;
    try {
      while (this.state.remaining === null && this.probe) await this.probe;
      const reset = this.state.resetAt === null ? null : Date.parse(this.state.resetAt);
      if (reset !== null && reset <= this.clock.now().getTime()) this.state.remaining = null;
      if (this.state.remaining !== null && this.state.remaining < estimate) {
        if (reset === null) throw new ForgeError("GraphQL budget exhausted; reset time unknown", null);
        await this.sleep(Math.max(0, reset - this.clock.now().getTime()));
        this.state.remaining = null;
      }
      this.state.calls++;
      this.state.spent += estimate;
      if (this.state.remaining !== null) this.state.remaining -= estimate;
      this.inFlight += estimate;
      if (this.state.remaining === null) {
        this.probe = new Promise<void>((resolve) => { settle = resolve; });
      }
    } finally {
      release();
    }
    try {
      // A cut body cannot report its cost. Keep the reservation charged in that case.
      const { value, rate } = await call();
      if (rate) this.reconcile(estimate, rate);
      return value;
    } finally {
      this.inFlight -= estimate;
      if (settle) {
        this.probe = null;
        settle();
      }
    }
  }

  private reconcile(estimate: number, rate: Rate): void {
    this.state.spent += rate.cost - estimate;
    const current = this.state.resetAt === null ? null : Date.parse(this.state.resetAt);
    const reported = Date.parse(rate.resetAt);
    if (current !== null && reported < current) return;
    // Other reservations still in flight are not yet in GitHub's figure.
    const remaining = Math.max(0, rate.remaining - (this.inFlight - estimate));
    const sameWindow = current === reported && this.state.remaining !== null;
    this.state.remaining = sameWindow ? Math.min(this.state.remaining ?? remaining, remaining) : remaining;
    this.state.resetAt = rate.resetAt;
  }
}

export const BUDGET_KEY = "spicodeBudget";

// Adds an aliased rateLimit selection to the operation's root, never to a fragment,
// so the caller's own rateLimit selections, aliases and directives cannot hide it.
function budgetQuery(query: string): { query: string; key: string } {
  const tokens = [...query.matchAll(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|#[^\r\n]*|[_A-Za-z][_0-9A-Za-z]*|[^\s,]/g)]
    .filter((token) => !token[0].startsWith('"') && !token[0].startsWith("#"));
  let depth = 0;
  let parens = 0;
  let fragment = false;
  let root: number | undefined;
  for (const token of tokens) {
    const text = token[0];
    if (text === BUDGET_KEY) throw new ForgeError(`GraphQL query may not use the name ${BUDGET_KEY}`, null);
    if (text === "(") parens++;
    if (text === ")") parens--;
    if (parens !== 0) continue;
    if (depth === 0 && (text === "mutation" || text === "subscription")) {
      throw new ForgeError(`GraphQL ${text} operations are not supported`, null);
    }
    if (depth === 0 && text === "fragment") fragment = true;
    if (text === "{") {
      if (depth === 0 && !fragment) {
        if (root !== undefined) throw new ForgeError("GraphQL document must hold one operation", null);
        root = token.index;
      }
      depth++;
    }
    if (text === "}") depth--;
    if (text === "}" && depth === 0) fragment = false;
  }
  if (root === undefined) throw new ForgeError("GraphQL query has no selection set", null);
  return {
    query: `${query.slice(0, root + 1)} ${BUDGET_KEY}: rateLimit { cost remaining resetAt } ${query.slice(root + 1)}`,
    key: BUDGET_KEY,
  };
}

export class Gh {
  constructor(
    private readonly exec: Exec,
    private readonly counter: CallCounter = { calls: 0 },
    readonly budget: GraphqlBudget = new GraphqlBudget(),
  ) {}

  async rest<T>(path: string, jq?: string): Promise<T> {
    this.counter.calls++;
    const args = ["api", path];
    if (jq) args.push("--jq", jq);
    const res = await this.exec.runJSON<T>("gh", args, { timeoutMs: 45_000 });
    if (!res.ok) throw new ForgeError(`gh api ${path}: ${res.error}`, res.code);
    return res.data;
  }

  async pages<T>(path: string, jq: string): Promise<T[]> {
    this.counter.calls++;
    const res = await this.exec.runText("gh", ["api", "--paginate", path, "--jq", jq], { timeoutMs: 90_000 });
    if (!res.ok) throw new ForgeError(`gh api ${path}: ${res.error}`, res.code);
    return res.data.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as T);
  }

  async text(path: string): Promise<string> {
    this.counter.calls++;
    const res = await this.exec.runText("gh", ["api", "--allow-escape-sequences", path], { timeoutMs: 60_000 });
    if (!res.ok) throw new ForgeError(`gh api ${path}: ${res.error}`, res.code);
    return res.data;
  }

  async graphql<T>(query: string, estimate = 1): Promise<{ data: T; errors: GqlError[] }> {
    const prepared = budgetQuery(query);
    let exitCode: number | null = null;
    let cut = "empty response";
    for (let attempt = 0; attempt < 2; attempt++) {
      const body = await this.budget.run(estimate, async () => {
        this.counter.calls++;
        const res = await this.exec.runText("gh", ["api", "graphql", "-f", `query=${prepared.query}`], {
          timeoutMs: 60_000, acceptNonZeroExit: true,
        });
        if (!res.ok) throw new ForgeError(`gh api graphql: ${res.error}`, res.code);
        exitCode = res.exitCode ?? null;
        let body: { data?: T & Record<string, unknown>; errors?: GqlError[] } | null = null;
        if (res.data.trim()) {
          try { body = JSON.parse(res.data); } catch { cut = `${res.data.length} bytes that were not JSON`; }
        } else cut = "empty response";
        const rate = rateSchema.safeParse(body?.data?.[prepared.key]);
        if (body?.data?.[prepared.key] != null && !rate.success) {
          throw new ForgeError("gh api graphql: invalid rateLimit budget", null);
        }
        return { value: body, ...(rate.success ? { rate: rate.data } : {}) };
      });
      if (!body) continue;
      const errors = body.errors ?? [];
      if (!body.data) throw new ForgeError(`gh api graphql: ${errors[0]?.message ?? "no data"}`, null);
      delete body.data[prepared.key];
      return { data: body.data, errors };
    }
    throw new ForgeError(
      `gh api graphql: GitHub cut the response short twice (exit ${exitCode}, ${cut})`, exitCode,
    );
  }

  async status(): Promise<{ ok: boolean; detail: string; scopes?: string[] }> {
    const res = await this.exec.runText("gh", ["auth", "status", "--hostname", "github.com"], {
      timeoutMs: 15_000, acceptNonZeroExit: true,
    });
    if (!res.ok) return { ok: false, detail: res.error };
    if (res.exitCode !== 0) return { ok: false, detail: "gh is not signed in to github.com" };
    const scopes = tokenScopes(res.data);
    const user = await this.exec.runText("gh", ["api", "user", "--jq", ".login"], { timeoutMs: 15_000 });
    return { ok: true, detail: user.ok ? `signed in as ${user.data.trim()}` : "signed in", ...(scopes ? { scopes } : {}) };
  }
}

export class Glab {
  constructor(private readonly exec: Exec, private readonly counter: CallCounter = { calls: 0 }) {}

  async rest<T>(path: string): Promise<T> {
    this.counter.calls++;
    const res = await this.exec.runJSON<T>("glab", ["api", "--hostname", GITLAB_HOST, path], { timeoutMs: 45_000 });
    if (!res.ok) throw new ForgeError(`glab api ${path}: ${res.error}`, res.code);
    return res.data;
  }

  async graphql<T>(query: string): Promise<T> {
    this.counter.calls++;
    const res = await this.exec.runJSON<{ data?: T; errors?: { message: string }[] }>(
      "glab", ["api", "graphql", "--hostname", GITLAB_HOST, "-f", `query=${query}`], { timeoutMs: 60_000 },
    );
    if (!res.ok) throw new ForgeError(`glab api graphql: ${res.error}`, res.code);
    if (!res.data.data) throw new ForgeError(`glab api graphql: ${res.data.errors?.[0]?.message ?? "no data"}`, null);
    return res.data.data;
  }

  async restAll<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; ; page++) {
      const batch = await this.rest<T[]>(`${path}${sep}per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) return out;
    }
  }

  async status(): Promise<{ ok: boolean; detail: string }> {
    const res = await this.exec.runText("glab", ["auth", "status", "--hostname", GITLAB_HOST], {
      timeoutMs: 15_000, acceptNonZeroExit: true,
    });
    if (!res.ok) return { ok: false, detail: res.error };
    return res.exitCode === 0
      ? { ok: true, detail: `signed in to ${GITLAB_HOST}` }
      : { ok: false, detail: `glab is not signed in to ${GITLAB_HOST}` };
  }
}

export function tokenScopes(statusText: string): string[] | undefined {
  const line = /Token scopes:\s*(.*)$/m.exec(statusText)?.[1];
  if (!line) return undefined;
  const scopes = [...line.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? "").filter(Boolean);
  return scopes.length > 0 ? scopes : undefined;
}

export function encodeProject(path: string): string {
  return encodeURIComponent(path);
}
