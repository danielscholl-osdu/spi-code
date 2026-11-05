// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";
import { type Exec, type ExecOutput, RecordingExec, ReplayExec } from "./exec/index.js";
import { encodeProject, Gh, Glab, GraphqlBudget, tokenScopes } from "./forge.js";

const resetAt = "2026-11-05T08:00:00Z";
const query = "{viewer{login}}";
const chargedQuery = "{ rateLimit { cost remaining resetAt } viewer{login}}";
const output = (stdout: string, exit = 0): ExecOutput => ({ stdout, stderr: "", exit });
const body = (cost: number, remaining: number) =>
  JSON.stringify({
    data: { viewer: { login: "someone" }, rateLimit: { cost, remaining, resetAt } },
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
            data: { missing: null, rateLimit: { cost: 2, remaining: 40, resetAt } },
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
    await replay([output(body(4, 2)), output(body(3, 97))], async (exec) => {
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
      expect(budget.snapshot()).toEqual({ remaining: 97, resetAt, spent: 7, calls: 2 });
    });
  });

  it.each([
    [query, chargedQuery],
    [chargedQuery, chargedQuery],
    [
      'query($s:String="{rateLimit}") {viewer{login}} # rateLimit',
      'query($s:String="{rateLimit}") { rateLimit { cost remaining resetAt } viewer{login}} # rateLimit',
    ],
    [
      "{quota:rateLimit { cost remaining resetAt }}",
      "{quota:rateLimit { cost remaining resetAt }}",
    ],
    [
      "fragment User on User {login} query {viewer{...User}}",
      "fragment User on User {login} query { rateLimit { cost remaining resetAt } viewer{...User}}",
    ],
    ["{rateLimit { remaining }}", "{rateLimit { cost resetAt  remaining }}"],
  ])("injects budget fields once at the root of %s", async (input, expected) => {
    let log = "";
    const recording = new RecordingExec(
      async (cmd, args) => {
        expect(cmd).toBe("gh");
        expect(args).toEqual(["api", "graphql", "-f", `query=${expected}`]);
        return output(
          JSON.stringify({
            data: {
              [input.includes("quota:") ? "quota" : "rateLimit"]: {
                cost: 1,
                remaining: 10,
                resetAt,
              },
            },
          }),
        );
      },
      (line) => {
        log += line;
      },
    );
    await new Gh(recording).graphql(input);
    const exec = new ReplayExec(log);
    await new Gh(exec).graphql(input);
    exec.assertExhausted();
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
