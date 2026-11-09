// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { type Clock, systemClock } from "./clock.js";
import { GITLAB_HOST } from "./config.js";
import type { Exec } from "./exec/index.js";

export type ForgeFailure = "throttle" | "gateway" | "cut";

export class ForgeError extends Error {
  constructor(
    message: string, readonly code: number | null, readonly kind?: ForgeFailure,
    readonly resumeAt?: string,
  ) {
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
export interface GraphqlThrottle {
  readonly reason: string;
  readonly resumeAt: string;
}
export type GraphqlThrottleHook = (event: GraphqlThrottle) => void;
const realSleep: Sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** How long one sweep may spend, in total, waiting out GitHub throttles: well under the
 * five-minute sweep interval, so a throttled sweep ends before the next is due. */
export const THROTTLE_WAIT_ALLOWANCE_MS = 90_000;

export class GraphqlBudget {
  private queue: Promise<void> = Promise.resolve();
  private inFlight = 0;
  private probe: Promise<void> | null = null;
  private heldUntil = 0;
  private heldFor = "";
  private allowance = { ms: THROTTLE_WAIT_ALLOWANCE_MS };
  private state: GraphqlBudgetSnapshot = { remaining: null, resetAt: null, spent: 0, calls: 0 };
  private parent: GraphqlBudget | undefined;
  private onThrottle: GraphqlThrottleHook | undefined;

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly sleep: Sleep = realSleep,
  ) {}

  snapshot(): GraphqlBudgetSnapshot {
    if (this.parent) return {
      ...this.parent.snapshot(), spent: this.state.spent, calls: this.state.calls,
    };
    return { ...this.state };
  }

  /** Shares reservations and rate limits; charges and throttle notifications belong to this scope. */
  scope(onThrottle?: GraphqlThrottleHook): GraphqlBudget {
    const scoped = new GraphqlBudget(this.clock, this.sleep);
    scoped.parent = this;
    scoped.onThrottle = onThrottle;
    return scoped;
  }

  /** Holds every later reservation, in every scope, until GitHub's stated wait has passed. */
  hold(ms: number, reason: string): void {
    if (this.parent) {
      this.parent.hold(ms, reason);
      return;
    }
    const until = this.clock.now().getTime() + ms;
    if (until <= this.heldUntil) return;
    this.heldUntil = until;
    this.heldFor = reason;
  }

  /** Sets how long, in total, this budget's reservations may wait out throttles from now on;
   * each budget and scope starts with THROTTLE_WAIT_ALLOWANCE_MS. A hold that outlasts what
   * is left fails the reservation without sending it, and the hold itself stays in place. */
  allowThrottleWait(ms: number): void {
    this.allowance = { ms };
  }

  /** The shared hold when it outlasts this scope's remaining throttle allowance. */
  throttled(): { until: string; reason: string } | undefined {
    const root = this.root();
    const wait = root.heldUntil - this.clock.now().getTime();
    if (wait <= 0 || wait <= this.allowance.ms) return undefined;
    return { until: new Date(root.heldUntil).toISOString(), reason: root.heldFor };
  }

  /** The current hold, including waits this scope can still afford. */
  throttle(): GraphqlThrottle | undefined {
    const root = this.root();
    if (root.heldUntil <= this.clock.now().getTime()) return undefined;
    return { resumeAt: new Date(root.heldUntil).toISOString(), reason: root.heldFor };
  }

  private root(): GraphqlBudget {
    return this.parent ? this.parent.root() : this;
  }

  // Reservations are serialised; the calls they pay for run concurrently once the
  // remaining budget is known. While it is unknown, one call probes it and the rest wait.
  run<T>(estimate: number, call: () => Promise<{ value: T; rate?: Rate }>): Promise<T> {
    return this.reserve(estimate, call, this.allowance, this.onThrottle);
  }

  private async reserve<T>(
    estimate: number, call: () => Promise<{ value: T; rate?: Rate }>, allowance: { ms: number },
    onThrottle?: GraphqlThrottleHook,
  ): Promise<T> {
    if (this.parent) return this.parent.reserve(estimate, async () => {
      this.state.calls++;
      this.state.spent += estimate;
      const result = await call();
      if (result.rate) this.state.spent += result.rate.cost - estimate;
      return result;
    }, allowance, onThrottle);
    if (!Number.isSafeInteger(estimate) || estimate < 1) {
      throw new ForgeError("GraphQL cost estimate must be a positive integer", null);
    }
    const previous = this.queue;
    let release = () => {};
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    let settle: (() => void) | undefined;
    let owned: Promise<void> | undefined;
    try {
      for (;;) {
        const held = this.heldUntil;
        if (held > this.clock.now().getTime()) {
          const wait = held - this.clock.now().getTime();
          const resumeAt = new Date(held).toISOString();
          onThrottle?.({ resumeAt, reason: this.heldFor });
          if (wait > allowance.ms) {
            throw new ForgeError(
              `gh api graphql: GitHub throttled GraphQL until ${new Date(held).toISOString()}, longer than this sweep may wait (${this.heldFor})`,
              null, "throttle", resumeAt,
            );
          }
          allowance.ms -= wait;
          await this.sleep(wait);
          if (this.heldUntil === held) this.heldUntil = 0;
          continue;
        }
        const reset = this.state.resetAt === null ? null : Date.parse(this.state.resetAt);
        if (reset !== null && reset <= this.clock.now().getTime()) this.state.remaining = null;
        if (this.state.remaining === null && this.probe) {
          await this.probe;
          continue;
        }
        if (this.state.remaining !== null && this.state.remaining < estimate) {
          if (reset === null) throw new ForgeError("GraphQL budget exhausted; reset time unknown", null);
          await this.sleep(Math.max(0, reset - this.clock.now().getTime()));
          this.state.remaining = null;
          continue;
        }
        break;
      }
      this.state.calls++;
      this.state.spent += estimate;
      if (this.state.remaining !== null) this.state.remaining -= estimate;
      this.inFlight += estimate;
      if (this.state.remaining === null) {
        owned = new Promise<void>((resolve) => { settle = resolve; });
        this.probe = owned;
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
        if (this.probe === owned) this.probe = null;
        settle();
      }
    }
  }

  private reconcile(estimate: number, rate: Rate): void {
    this.state.spent += rate.cost - estimate;
    const current = this.state.resetAt === null ? null : Date.parse(this.state.resetAt);
    const reported = Date.parse(rate.resetAt);
    // A figure from a window that has already reset says nothing about the current one.
    if (reported <= this.clock.now().getTime()) return;
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
  // Only the first token of a top-level definition is its keyword; later names are
  // operation names, fragment names, type conditions or directives.
  let definitionStart = true;
  let fragment = false;
  let root: number | undefined;
  for (const token of tokens) {
    const text = token[0];
    if (text === BUDGET_KEY) throw new ForgeError(`GraphQL query may not use the name ${BUDGET_KEY}`, null);
    if (text === "(") parens++;
    if (text === ")") parens--;
    if (parens !== 0) continue;
    if (depth === 0 && definitionStart) {
      definitionStart = false;
      if (text === "mutation" || text === "subscription") {
        throw new ForgeError(`GraphQL ${text} operations are not supported`, null);
      }
      if (text === "fragment") fragment = true;
      else if (text !== "query" && text !== "{") {
        throw new ForgeError(`GraphQL definition ${text} is not supported`, null);
      }
    }
    if (text === "{") {
      if (depth === 0 && !fragment) {
        if (root !== undefined) throw new ForgeError("GraphQL document must hold one operation", null);
        root = token.index;
      }
      depth++;
    }
    if (text === "}") depth--;
    if (text === "}" && depth === 0) {
      fragment = false;
      definitionStart = true;
    }
  }
  if (root === undefined) throw new ForgeError("GraphQL query has no selection set", null);
  return {
    query: `${query.slice(0, root + 1)} ${BUDGET_KEY}: rateLimit { cost remaining resetAt } ${query.slice(root + 1)}`,
    key: BUDGET_KEY,
  };
}

const DEFAULT_THROTTLE_WAIT_MS = 60_000;
const THROTTLE_TEXT = /secondary rate limit|abuse detection|rate limit exceeded|too many requests/i;

/** What one `gh api graphql` reply was. gh prints a non-JSON body to stdout as it came and
 * names the status on stderr ("gh: HTTP 502"); a JSON error body's message goes to stderr
 * with "(HTTP 403)" after it. */
export type GraphqlReply =
  | {
      kind: "json";
      body: { data?: Record<string, unknown> | null; errors?: GqlError[] };
      message?: string;
    }
  | { kind: "throttle"; detail: string; waitMs: number }
  | { kind: "gateway"; status: number; detail: string }
  | { kind: "cut"; detail: string };

export function classifyGraphqlReply(stdout: string, stderr: string): GraphqlReply {
  const said = stderr.split("\n").map((line) => line.trim()).find(Boolean);
  const html = /<title>\s*(\d{3})\b|<h1>\s*(\d{3})\b/i.exec(stdout);
  const statusText = /\bHTTP (\d{3})\b/.exec(stderr)?.[1] ?? html?.[1] ?? html?.[2];
  const status = statusText ? Number(statusText) : null;
  let body: unknown;
  let parsed = false;
  if (stdout.trim()) {
    try {
      body = JSON.parse(stdout);
      parsed = true;
    } catch {}
  }
  const shaped = parsed && !!body && typeof body === "object" && !Array.isArray(body);
  const record = shaped ? (body as Record<string, unknown>) : {};
  const message = typeof record.message === "string" ? record.message : undefined;
  const errors = Array.isArray(record.errors) ? (record.errors as GqlError[]) : [];
  const limited = errors.find((error) => error?.type === "RATE_LIMITED");
  const throttleText = [message, limited?.message, said].find((text) => text && THROTTLE_TEXT.test(text));
  if (status === 429 || limited || throttleText) {
    const text = throttleText ?? limited?.message ?? message ?? said ?? `HTTP ${status}`;
    return { kind: "throttle", detail: text, waitMs: statedWait(text) };
  }
  if (shaped) return { kind: "json", body: record, ...(message ? { message } : {}) };
  const what = !stdout.trim()
    ? "empty response"
    : stdout.trimStart().startsWith("<")
      ? `${stdout.length} bytes of HTML`
      : `${stdout.length} bytes that were not JSON`;
  if (status !== null && status >= 500) return { kind: "gateway", status, detail: what };
  return { kind: "cut", detail: said ? `${what}; ${said}` : what };
}

function statedWait(text: string): number {
  const stated = /(\d+)\s*(second|minute)s?\b/i.exec(text);
  if (!stated) return DEFAULT_THROTTLE_WAIT_MS;
  return Number(stated[1]) * (stated[2]?.toLowerCase() === "minute" ? 60_000 : 1_000);
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
    let failed: Exclude<GraphqlReply, { kind: "json" }> = { kind: "cut", detail: "empty response" };
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await this.budget.run(estimate, async () => {
        this.counter.calls++;
        const res = await this.exec.runText("gh", ["api", "graphql", "-f", `query=${prepared.query}`], {
          timeoutMs: 60_000, acceptNonZeroExit: true,
        });
        if (!res.ok) throw new ForgeError(`gh api graphql: ${res.error}`, res.code);
        exitCode = res.exitCode ?? null;
        const reply = classifyGraphqlReply(res.data, res.stderr ?? "");
        // Held before the probe settles, so no caller waiting on it sends inside the wait.
        if (reply.kind === "throttle") this.budget.hold(reply.waitMs, reply.detail);
        const data = reply.kind === "json" ? reply.body.data : undefined;
        const rate = rateSchema.safeParse(data?.[prepared.key]);
        if (data?.[prepared.key] != null && !rate.success) {
          throw new ForgeError("gh api graphql: invalid rateLimit budget", null);
        }
        return { value: reply, ...(rate.success ? { rate: rate.data } : {}) };
      });
      if (reply.kind !== "json") {
        failed = reply;
        continue;
      }
      const body = reply.body as { data?: T & Record<string, unknown> | null; errors?: GqlError[] };
      const errors = body.errors ?? [];
      if (!body.data) {
        throw new ForgeError(`gh api graphql: ${errors[0]?.message ?? reply.message ?? "no data"}`, null);
      }
      delete body.data[prepared.key];
      return { data: body.data, errors };
    }
    if (failed.kind === "throttle") {
      throw new ForgeError(
        `gh api graphql: GitHub throttled the query (${failed.detail})`, exitCode, "throttle",
        this.budget.throttle()?.resumeAt,
      );
    }
    if (failed.kind === "gateway") {
      throw new ForgeError(
        `gh api graphql: GitHub answered HTTP ${failed.status} twice (${failed.detail}, a gateway error rather than a GraphQL reply)`,
        exitCode, "gateway",
      );
    }
    throw new ForgeError(
      `gh api graphql: GitHub cut the response short twice (exit ${exitCode}, ${failed.detail})`, exitCode, "cut",
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
