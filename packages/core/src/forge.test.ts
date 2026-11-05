// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Exec, type ExecOutput, RecordingExec, ReplayExec } from "./exec/index.js";
import { encodeProject, Gh, Glab, GraphqlBudget, tokenScopes } from "./forge.js";

const resetAt = "2026-11-05T08:00:00Z";
const query = "{viewer{login}}";
const charge = "spicodeBudget: rateLimit { cost remaining resetAt }";
const output = (stdout: string, exit = 0): ExecOutput => ({ stdout, stderr: "", exit });
const nextResetAt = "2026-11-05T09:00:00Z";
const body = (cost: number, remaining: number, reset = resetAt) =>
  JSON.stringify({
    data: { viewer: { login: "someone" }, spicodeBudget: { cost, remaining, resetAt: reset } },
  });

async function replay(
  outputs: ExecOutput[],
  scenario: (exec: Exec) => Promise<void>,
): Promise<void> {
  let log = "";
  const pending = [...outputs];
  await scenario(
    new RecordingExec(
      async () => {
        const next = pending.shift();
        if (!next) throw new Error("unexpected command");
        return next;
      },
      (line) => {
        log += line;
      },
    ),
  );
  expect(pending).toEqual([]);
  const exec = new ReplayExec(log);
  await scenario(exec);
  exec.assertExhausted();
}

afterEach(() => vi.useRealTimers());

describe("forge replay", () => {
  // Fixtures carry fixed rate-limit windows and the budget discards expired ones, so the
  // suite runs inside the first window rather than against the wall clock.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T07:00:00Z"));
  });

  it("ports REST, paginated jq lines, text, GitLab paging and GraphQL", async () => {
    await replay(
      [
        output('{"name":"repo"}'),
        output('{"id":1}\n\n{"id":2}\n'),
        output("raw\n"),
        output(JSON.stringify(Array.from({ length: 100 }, (_, id) => ({ id })))),
        output('[{"id":100}]'),
        output('{"data":{"project":{"id":"p"}}}'),
      ],
      async (exec) => {
        const counter = { calls: 0 };
        const gh = new Gh(exec, counter);
        const glab = new Glab(exec, counter);
        expect(await gh.rest("repos/org/repo", ".")).toEqual({ name: "repo" });
        expect(await gh.pages("repos/org/repo/pulls", ".[]")).toEqual([{ id: 1 }, { id: 2 }]);
        expect(await gh.text("repos/org/repo/readme")).toBe("raw\n");
        expect(
          await glab.restAll(
            `projects/${encodeProject("group/project")}/merge_requests?state=merged`,
          ),
        ).toHaveLength(101);
        expect(await glab.graphql("{project{id}}")).toEqual({ project: { id: "p" } });
        expect(counter.calls).toBe(6);
      },
    );
  });

  it("charges a cut response's reservation and the retry's reported cost", async () => {
    await replay([output('{"data":', 1), output(body(7, 42))], async (exec) => {
      const counter = { calls: 0 };
      const gh = new Gh(exec, counter);
      expect((await gh.graphql<{ viewer: { login: string } }>(query, 3)).data.viewer.login).toBe(
        "someone",
      );
      expect(counter.calls).toBe(2);
      expect(gh.budget.snapshot()).toEqual({ remaining: 42, resetAt, spent: 10, calls: 2 });
    });
  });

  it("retries an empty body and retains partial data beside NOT_FOUND errors", async () => {
    const errors = [{ type: "NOT_FOUND", path: ["missing"], message: "not found" }];
    await replay(
      [
        output("", 1),
        output(
          JSON.stringify({
            data: { missing: null, spicodeBudget: { cost: 2, remaining: 40, resetAt } },
            errors,
          }),
          1,
        ),
      ],
      async (exec) => {
        const gh = new Gh(exec);
        expect(await gh.graphql(query)).toMatchObject({ data: { missing: null }, errors });
        expect(gh.budget.snapshot().spent).toBe(3);
      },
    );
  });

  it.each(["", "upstream"])("fails after two cut responses (%s) and charges both", async (cut) => {
    await replay([output(cut, 1), output(cut, 1)], async (exec) => {
      const gh = new Gh(exec);
      await expect(gh.graphql(query)).rejects.toThrow(
        `GitHub cut the response short twice (exit 1, ${
          cut ? "8 bytes that were not JSON" : "empty response"
        })`,
      );
      expect(gh.budget.snapshot()).toMatchObject({ spent: 2, calls: 2 });
    });
  });

  it("queues concurrent clients on one budget until reset when the second estimate exceeds remaining", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-05T07:59:59Z"));
    await replay([output(body(4, 2)), output(body(3, 97, nextResetAt))], async (exec) => {
      vi.setSystemTime(new Date("2026-11-05T07:59:59Z"));
      const budget = new GraphqlBudget();
      const first = new Gh(exec, undefined, budget).graphql(query, 4);
      let finished = false;
      const second = new Gh(exec, undefined, budget).graphql(query, 3).then(() => {
        finished = true;
      });
      await first;
      await vi.advanceTimersByTimeAsync(999);
      expect(finished).toBe(false);
      expect(budget.snapshot()).toEqual({ remaining: 2, resetAt, spent: 4, calls: 1 });
      await vi.advanceTimersByTimeAsync(1);
      await second;
      expect(budget.snapshot()).toEqual({
        remaining: 97,
        resetAt: nextResetAt,
        spent: 7,
        calls: 2,
      });
    });
  });

  it.each([
    [query, `{ ${charge} viewer{login}}`],
    [
      'query($s:String="{rateLimit}") {viewer{login}} # rateLimit',
      `query($s:String="{rateLimit}") { ${charge} viewer{login}} # rateLimit`,
    ],
    [
      "{quota:rateLimit { cost remaining resetAt }}",
      `{ ${charge} quota:rateLimit { cost remaining resetAt }}`,
    ],
    [
      "fragment User on User {login} query {viewer{...User}}",
      `fragment User on User {login} query { ${charge} viewer{...User}}`,
    ],
    [
      "{ ...rateLimit } fragment rateLimit on Query { viewer { login } }",
      `{ ${charge}  ...rateLimit } fragment rateLimit on Query { viewer { login } }`,
    ],
    [
      "{rateLimit { used:cost remaining resetAt }}",
      `{ ${charge} rateLimit { used:cost remaining resetAt }}`,
    ],
    [
      "{viewer{login} rateLimit @skip(if:true) {cost remaining resetAt}}",
      `{ ${charge} viewer{login} rateLimit @skip(if:true) {cost remaining resetAt}}`,
    ],
    ["{ rateLimit: viewer { login } }", `{ ${charge}  rateLimit: viewer { login } }`],
    ["query mutation { viewer { login } }", `query mutation { ${charge}  viewer { login } }`],
    ["query fragment { viewer { login } }", `query fragment { ${charge}  viewer { login } }`],
    [
      "{ viewer { ...mutation } } fragment mutation on User { login }",
      `{ ${charge}  viewer { ...mutation } } fragment mutation on User { login }`,
    ],
    [
      "query Q @include(if: true) { viewer { login } }",
      `query Q @include(if: true) { ${charge}  viewer { login } }`,
    ],
  ])(
    "injects one aliased budget selection at the operation root of %s",
    async (input, expected) => {
      let log = "";
      const recording = new RecordingExec(
        async (cmd, args) => {
          expect(cmd).toBe("gh");
          expect(args).toEqual(["api", "graphql", "-f", `query=${expected}`]);
          return output(
            JSON.stringify({
              data: { rateLimit: { used: 9 }, spicodeBudget: { cost: 1, remaining: 10, resetAt } },
            }),
          );
        },
        (line) => {
          log += line;
        },
      );
      const gh = new Gh(recording);
      expect((await gh.graphql(input)).data).toEqual({ rateLimit: { used: 9 } });
      expect(gh.budget.snapshot()).toEqual({ remaining: 10, resetAt, spent: 1, calls: 1 });
      const exec = new ReplayExec(log);
      await new Gh(exec).graphql(input);
      exec.assertExhausted();
    },
  );

  it.each([
    ['mutation { addStar(input:{starrableId:"x"}) { clientMutationId } }', "mutation operations"],
    ["subscription { x }", "subscription operations"],
    ["{ spicodeBudget: viewer { login } }", "may not use the name spicodeBudget"],
    ["query A { a } query B { b }", "one operation"],
    ["extend type Query { a: Int }", "definition extend is not supported"],
  ])("refuses %s before calling gh", async (input, message) => {
    const exec = new ReplayExec("");
    await expect(new Gh(exec).graphql(input)).rejects.toThrow(message);
    exec.assertExhausted();
  });

  it("probes an unknown budget with one call, then runs calls concurrently and reconciles in-flight reservations", async () => {
    let active = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const exec = new RecordingExec(
      async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        return output(body(1, 100));
      },
      () => {},
    );
    const budget = new GraphqlBudget();
    const gh = new Gh(exec, undefined, budget);
    const probe = gh.graphql(query, 5);
    const waiting = gh.graphql(query, 5);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases[0]?.();
    await probe;
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    const third = gh.graphql(query, 5);
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    expect(peak).toBe(2);
    releases[1]?.();
    await waiting;
    expect(budget.snapshot().remaining).toBe(90);
    releases[2]?.();
    await third;
    expect(budget.snapshot()).toEqual({ remaining: 90, resetAt, spent: 3, calls: 3 });
  });

  it("ignores an expired window's figure while a new-window probe is pending", async () => {
    let now = Date.parse("2026-11-05T07:59:00Z");
    const budget = new GraphqlBudget({ now: () => new Date(now) });
    await budget.run(1, async () => ({ value: 0, rate: { cost: 1, remaining: 10, resetAt } }));
    const resolvers: ((rate: { cost: number; remaining: number; resetAt: string }) => void)[] = [];
    let calls = 0;
    const call = () => {
      calls++;
      return new Promise<{
        value: number;
        rate: { cost: number; remaining: number; resetAt: string };
      }>((resolve) => resolvers.push((rate) => resolve({ value: 1, rate })));
    };
    const a = budget.run(1, call);
    await vi.waitFor(() => expect(calls).toBe(1));
    now = Date.parse("2026-11-05T08:00:01Z");
    const b = budget.run(1, call);
    await vi.waitFor(() => expect(calls).toBe(2));
    resolvers[0]?.({ cost: 1, remaining: 8, resetAt });
    await a;
    expect(budget.snapshot().remaining).toBeNull();
    const c = budget.run(1, call);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(2);
    resolvers[1]?.({ cost: 1, remaining: 4999, resetAt: nextResetAt });
    await b;
    await vi.waitFor(() => expect(calls).toBe(3));
    resolvers[2]?.({ cost: 1, remaining: 4998, resetAt: nextResetAt });
    await c;
    expect(budget.snapshot()).toMatchObject({ remaining: 4998, resetAt: nextResetAt, calls: 4 });
  });

  it("waits on the injected sleep rather than wall time", async () => {
    const sleeps: number[] = [];
    const clock = { now: () => new Date("2026-11-05T07:59:00Z") };
    const budget = new GraphqlBudget(clock, async (ms) => {
      sleeps.push(ms);
    });
    await budget.run(1, async () => ({ value: 1, rate: { cost: 1, remaining: 0, resetAt } }));
    await budget.run(1, async () => ({ value: 2 }));
    expect(sleeps).toEqual([60_000]);
  });

  it("ports the status-scope case, including a fine-grained token without scopes", async () => {
    const status = "  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'\n";
    expect(tokenScopes(status)).toEqual(["gist", "read:org", "repo", "workflow"]);
    expect(tokenScopes("  ✓ Logged in to github.com account someone (GH_TOKEN)\n")).toBeUndefined();
    await replay([output(status), output("someone\n"), output("", 1), output("")], async (exec) => {
      const gh = new Gh(exec);
      expect(await gh.status()).toEqual({
        ok: true,
        detail: "signed in as someone",
        scopes: ["gist", "read:org", "repo", "workflow"],
      });
      expect((await gh.status()).ok).toBe(false);
      expect((await new Glab(exec).status()).ok).toBe(true);
    });
  });

  it("surfaces API errors and releases the budget queue after failure", async () => {
    await replay(
      [output('{"errors":[{"message":"denied"}]}', 1), output(body(2, 10))],
      async (exec) => {
        const gh = new Gh(exec);
        await expect(gh.graphql(query)).rejects.toThrow("gh api graphql: denied");
        await gh.graphql(query);
        expect(gh.budget.snapshot()).toMatchObject({ calls: 2, spent: 3 });
      },
    );
  });
});
