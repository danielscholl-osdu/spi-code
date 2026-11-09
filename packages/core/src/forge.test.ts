// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readGithub } from "./collect/github-read.js";
import { fleetOf } from "./config.js";
import { createContext } from "./context.js";
import { type Exec, type ExecOutput, RecordingExec, ReplayExec } from "./exec/index.js";
import {
  classifyGraphqlReply,
  encodeProject,
  ForgeError,
  Gh,
  Glab,
  GraphqlBudget,
  type GraphqlThrottle,
  THROTTLE_WAIT_ALLOWANCE_MS,
  tokenScopes,
} from "./forge.js";

const resetAt = "2026-11-05T08:00:00Z";
const query = "{viewer{login}}";
const charge = "spicodeBudget: rateLimit { cost remaining resetAt }";
const output = (stdout: string, exit: number | null = 0): ExecOutput => ({
  stdout,
  stderr: "",
  exit,
});
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

  it.each([
    { error: "spawn glab ENOENT", signin: true, detail: "glab is not installed" },
    { error: "Command timed out after 15000ms.", signin: false },
    { error: "sign in or retry after a timeout", signin: false },
  ])("classifies glab status execution failure: $error", async ({ error, signin, detail }) => {
    await replay([{ ...output("", null), error }], async (exec) => {
      const onSigninFailure = vi.fn();
      expect(await new Glab(exec).status(onSigninFailure)).toEqual({
        ok: false,
        detail: detail ?? error,
      });
      expect(onSigninFailure).toHaveBeenCalledTimes(signin ? 1 : 0);
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

// nginx's stock 502 page: the 150 bytes the radar's port-PR searches got back (spicode-t1k.134).
const NGINX_502 =
  "<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n";
const SECONDARY_LIMIT = JSON.stringify({
  documentation_url:
    "https://docs.github.com/free-pro-team@latest/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits",
  message:
    "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
});
const failed = (stdout: string, stderr: string): ExecOutput => ({ stdout, stderr, exit: 1 });

describe("GraphQL reply classification", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T07:00:00Z"));
  });

  it("names the failing radar reply a gateway error, not a throttle or a cut body", () => {
    expect(NGINX_502).toHaveLength(150);
    expect(classifyGraphqlReply(NGINX_502, "gh: HTTP 502\n")).toEqual({
      kind: "gateway",
      status: 502,
      detail: "150 bytes of HTML",
    });
    expect(classifyGraphqlReply(NGINX_502, "")).toMatchObject({ kind: "gateway", status: 502 });
  });

  it("names secondary limits, 429s and RATE_LIMITED errors throttles", () => {
    expect(
      classifyGraphqlReply(
        SECONDARY_LIMIT,
        "gh: You have exceeded a secondary rate limit. (HTTP 403)\n",
      ),
    ).toMatchObject({ kind: "throttle", waitMs: 60_000 });
    expect(classifyGraphqlReply("", "gh: HTTP 429\n")).toMatchObject({ kind: "throttle" });
    expect(
      classifyGraphqlReply(
        JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }),
        "",
      ),
    ).toMatchObject({ kind: "throttle" });
    expect(
      classifyGraphqlReply(
        JSON.stringify({ message: "Too many requests. Retry after 30 seconds." }),
        "",
      ),
    ).toMatchObject({ kind: "throttle", waitMs: 30_000 });
  });

  it("keeps a truncated body a cut and carries gh's own words", () => {
    expect(classifyGraphqlReply("", "gh: unexpected EOF\n")).toEqual({
      kind: "cut",
      detail: "empty response; gh: unexpected EOF",
    });
    expect(classifyGraphqlReply('{"data":', "")).toEqual({
      kind: "cut",
      detail: "8 bytes that were not JSON",
    });
  });

  it("reports two gateway replies as a gateway error", async () => {
    await replay(
      [failed(NGINX_502, "gh: HTTP 502\n"), failed(NGINX_502, "gh: HTTP 502\n")],
      async (exec) => {
        const gh = new Gh(exec);
        const error = await gh.graphql(query).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ForgeError);
        expect((error as ForgeError).kind).toBe("gateway");
        expect((error as ForgeError).message).toBe(
          "gh api graphql: GitHub answered HTTP 502 twice (150 bytes of HTML, a gateway error rather than a GraphQL reply)",
        );
      },
    );
  });

  it("waits out a throttle on the shared budget before retrying", async () => {
    await replay(
      [
        failed(SECONDARY_LIMIT, "gh: You have exceeded a secondary rate limit. (HTTP 403)\n"),
        output(body(1, 41)),
      ],
      async (exec) => {
        const sleeps: number[] = [];
        const root = new GraphqlBudget(undefined, async (ms) => {
          sleeps.push(ms);
        });
        const gh = new Gh(exec, undefined, root.scope());
        expect((await gh.graphql<{ viewer: { login: string } }>(query)).data.viewer.login).toBe(
          "someone",
        );
        expect(sleeps).toEqual([60_000]);
        expect(gh.budget.snapshot()).toMatchObject({ calls: 2, remaining: 41 });
      },
    );
  });

  it("gives up on a throttle that persists and says so", async () => {
    const limited = failed(SECONDARY_LIMIT, "gh: HTTP 403\n");
    await replay([limited, limited], async (exec) => {
      const gh = new Gh(exec, undefined, new GraphqlBudget(undefined, async () => {}));
      const error = await gh.graphql(query).catch((caught: unknown) => caught);
      expect((error as ForgeError).kind).toBe("throttle");
      expect((error as ForgeError).message).toContain("GitHub throttled the query");
    });
  });
});

describe("GraphQL throttle holds", () => {
  const start = Date.parse("2026-11-05T07:00:00Z");
  const limited = (seconds: number) =>
    failed(
      JSON.stringify({
        message: `You have exceeded a secondary rate limit. Retry after ${seconds} seconds.`,
      }),
      "gh: HTTP 403\n",
    );
  // Timers faked: the budget sleeps on setTimeout and the clock reads the faked time.
  const clock = { now: () => vi.getMockedSystemTime() ?? new Date(Number.NaN) };
  const elapsed = () => clock.now().getTime() - start;
  function timed(reply: (call: number) => ExecOutput) {
    const calls: number[] = [];
    const exec = new RecordingExec(
      async () => {
        calls.push(elapsed());
        return reply(calls.length);
      },
      () => {},
    );
    const budget = new GraphqlBudget(
      clock,
      (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    );
    return { calls, exec, budget };
  }
  async function settle<T>(pending: Promise<T>): Promise<T> {
    await vi.runAllTimersAsync();
    return pending;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds a sibling scope queued behind the throttled probe until the stated wait passes", async () => {
    const { calls, exec, budget } = timed((call) =>
      call === 1 ? limited(60) : output(body(1, 41)),
    );
    const first = new Gh(exec, undefined, budget.scope());
    const sibling = new Gh(exec, undefined, budget.scope());
    await settle(Promise.all([first.graphql(query), sibling.graphql("{viewer{id}}")]));
    expect(calls).toEqual([0, 60_000, 60_000]);
  });

  it("notifies only the reserving scope before its throttle sleep completes", async () => {
    const { calls, exec, budget } = timed(() => output(body(1, 41)));
    const notices: GraphqlThrottle[] = [];
    const siblingNotices: GraphqlThrottle[] = [];
    budget.hold(30_000, "secondary rate limit");
    const first = new Gh(
      exec,
      undefined,
      budget.scope((event) => notices.push(event)),
    );
    const sibling = new Gh(
      exec,
      undefined,
      budget.scope((event) => siblingNotices.push(event)),
    );
    const pending = first.graphql(query);
    await vi.advanceTimersByTimeAsync(0);
    expect(notices).toEqual([
      { reason: "secondary rate limit", resumeAt: "2026-11-05T07:00:30.000Z" },
    ]);
    expect(siblingNotices).toEqual([]);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    await sibling.graphql(query);
    expect(calls).toEqual([30_000, 30_000]);
    expect(notices).toHaveLength(1);
    expect(siblingNotices).toEqual([]);
  });

  it("keeps the not-before time of a wait too long to retry inline", async () => {
    const { calls, exec, budget } = timed((call) =>
      call === 1 ? limited(180) : output(body(1, 41)),
    );
    const error = await settle(
      new Gh(exec, undefined, budget.scope()).graphql(query).catch((caught: unknown) => caught),
    );
    expect(error).toMatchObject({ kind: "throttle" });
    const later = await settle(
      new Gh(exec, undefined, budget.scope()).graphql(query).catch((caught: unknown) => caught),
    );
    expect(later).toMatchObject({ kind: "throttle" });
    expect((later as ForgeError).message).toContain("until 2026-11-05T07:03:00.000Z");
    expect(calls).toEqual([0]);
    const patient = budget.scope();
    patient.allowThrottleWait(200_000);
    await settle(new Gh(exec, undefined, patient).graphql(query));
    expect(calls).toEqual([0, 180_000]);
  });

  it.each([60, 120])(
    "bounds a 13-fork collector under persistent %ss throttles by the sweep's allowance",
    async (seconds) => {
      const { calls, exec, budget } = timed(() => limited(seconds));
      const ctx = createContext({
        clock,
        fleet: fleetOf(
          Array.from({ length: 13 }, (_, i) => ({
            id: `svc${i}`,
            repo: `Azure/osdu-spi-svc${i}`,
            upstream: `osdu/platform/svc${i}`,
            seeded: "2026-08-04",
          })),
        ),
      });
      const result = await settle(readGithub(new Gh(exec, undefined, budget), ctx, (raw) => raw));
      expect(elapsed()).toBeLessThanOrEqual(THROTTLE_WAIT_ALLOWANCE_MS);
      expect(result.records.length).toBeGreaterThan(0);
      expect(result.records.every((record) => record.failure?.includes("throttled"))).toBe(true);
      expect(calls.length).toBeLessThanOrEqual(2);
    },
  );
});
