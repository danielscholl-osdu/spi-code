// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, test } from "vitest";
import {
  CORE_LIB_REPO,
  fleetOf,
  GITLAB_EVERY_MS,
  RELEASES_EVERY_MS,
  SECURITY_EVERY_MS,
  STACK_REPO,
  shortRepo,
} from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { RecordingExec, ReplayExec } from "../../src/exec/index.js";
import type { ExecOutput } from "../../src/exec/port.js";
import { emptyFacts } from "../../src/facts.js";
import { factsSchema } from "../../src/facts-schema.js";
import { GraphqlBudget } from "../../src/forge.js";
import { createSweeper } from "../../src/sweep/areas.js";
import { cacheSchema, emptyCache, pruneCache } from "../../src/sweep/cache.js";
import { due } from "../../src/sweep/cadence.js";
import type { SweepProgress, SweepState } from "../../src/sweep/sweeper.js";

const START = "2026-10-14T00:00:00.000Z";

function harness(repo = "owner/partition", remaining = 4000) {
  let time = Date.parse(START);
  let offline = false;
  let retry = true;
  let stored: unknown;
  let route: ((cmd: string, args: string[]) => ExecOutput | undefined) | undefined;
  const costs: number[] = [];
  const queries: string[] = [];
  const log: string[] = [];
  const ctx = createContext({
    fleet: fleetOf([{ id: "partition", repo, upstream: "osdu/partition", seeded: "2026-10-13" }]),
    clock: { now: () => new Date(time) },
  });
  const exec = new RecordingExec(
    async (cmd, args) => {
      const overridden = route?.(cmd, args);
      if (overridden) return overridden;
      if (offline) return { stdout: "", stderr: `${cmd} unavailable`, exit: 1 };
      const path =
        args.find(
          (a) => a.startsWith("repos/") || a.startsWith("projects/") || a.startsWith("groups/"),
        ) ?? "";
      const query = args.find((a) => a.startsWith("query=")) ?? "";
      let data: unknown;
      if (cmd === "gh" && query) {
        queries.push(query);
        if (query.includes("port_o0") && retry) {
          retry = false;
          costs.push(4);
          return { stdout: "", stderr: "", exit: 0 };
        }
        let payload: object;
        if (query.includes("stack: repository"))
          payload = {
            stack: { object: { text: `forks:\n  - service: partition\n    repo: ${repo}\n` } },
            template: { object: null },
          };
        else if (query.includes("r_template:") || query.includes("r_fork0:")) {
          const raw = (nameWithOwner: string) => ({
            nameWithOwner,
            url: `https://github.com/${nameWithOwner}`,
          });
          payload = query.includes("r_template:")
            ? { r_template: raw("Azure/osdu-spi"), r_stack: raw("Azure/osdu-spi-stack") }
            : { r_fork0: raw(repo) };
        } else if (query.includes("port_o0"))
          payload = {
            port_o0: { issueCount: 0, nodes: [], pageInfo: { hasNextPage: false } },
            port_m0: { issueCount: 0, nodes: [], pageInfo: { hasNextPage: false } },
          };
        else if (query.includes("pom0:")) payload = { pom0: { root: { oid: "blob" } } };
        else if (query.includes("createdAt"))
          payload = Object.fromEntries(
            ctx.fleet.releaseRepos.map((_, i) => [`r${i}`, { createdAt: START }]),
          );
        else payload = { repository: { p0: { text: "<java.version>21</java.version>" } } };
        const cost = query.includes("port_o0") ? 7 : query.includes("createdAt") ? 3 : 2;
        costs.push(cost);
        data = {
          data: {
            ...payload,
            spicodeBudget: {
              cost,
              remaining,
              resetAt: "2099-01-01T00:00:00Z",
            },
          },
        };
      } else if (cmd === "glab" && query)
        data = {
          data: {
            p0: { mergeRequests: { nodes: [], pageInfo: { hasNextPage: false } } },
          },
        };
      else if (args.includes("status")) return { stdout: "", stderr: "", exit: 0 };
      else if (path.endsWith("actions/variables?per_page=100&page=1"))
        data = { total_count: 0, variables: [] };
      else if (path.includes("/attempts/")) data = { total: 0, jobs: [] };
      else if (path.includes("/workflows/cascade.yml/"))
        data = {
          total: 1,
          runs: [
            {
              id: 5,
              name: "Cascade",
              path: "cascade.yml",
              event: "push",
              status: "completed",
              conclusion: "failure",
              created_at: START,
              updated_at: START,
              head_branch: "main",
              head_sha: "cascade",
              display_title: "Cascade",
              html_url: "u",
              run_attempt: 1,
            },
          ],
        };
      else if (path.includes("/actions/")) data = { total: 0, runs: [] };
      else if (path.endsWith("/commits/fork_integration")) data = { sha: "integration", at: START };
      else if (path.includes("/releases?"))
        return {
          stdout: JSON.stringify({ tag: "v1.0.0", at: START, body: "" }),
          stderr: "",
          exit: 0,
        };
      else if (path.includes("/git/trees/")) data = { paths: [], truncated: false };
      else if (path.includes("/git/blobs/"))
        data = {
          content: Buffer.from("<os-core-common.version>1.0.0</os-core-common.version>").toString(
            "base64",
          ),
        };
      else if (path.includes("upstream-filter.yml"))
        data = {
          sha: "filter",
          content: Buffer.from("top_level:\n  docs: shared\n").toString("base64"),
        };
      else if (path.includes("/repository/branches/"))
        data = { commit: { id: "head", committed_date: START } };
      else if (path.includes("/repository/files/"))
        data = { content: Buffer.from("<project/>").toString("base64") };
      else if (path.includes("/repository/tags")) data = [{ name: "v1.0.0" }];
      else if (cmd === "glab") data = [];
      else if (path.includes("/dependabot/") || path.includes("/code-scanning/"))
        return { stdout: "", stderr: "", exit: 0 };
      else return { stdout: "", stderr: `unhandled ${cmd} ${args.join(" ")}`, exit: 1 };
      return { stdout: JSON.stringify(data), stderr: "", exit: 0 };
    },
    (line) => {
      log.push(line);
    },
  );
  const persist = {
    load: async () => structuredClone(stored),
    save: async (state: SweepState<ReturnType<typeof emptyCache>>) => {
      stored = structuredClone(state);
    },
  };
  const options = { ctx, exec, persist, factsSchema };
  return {
    options,
    costs,
    queries,
    log,
    setRoute: (next: typeof route) => {
      route = next;
    },
    setOffline: () => {
      offline = true;
    },
    advance: (ms: number) => {
      time += ms;
    },
  };
}

test("multi-area exec replay accounts for ledger, release, pin and retried GraphQL calls", async () => {
  const h = harness();
  const progress: SweepProgress[] = [];
  const sweeper = createSweeper({ ...h.options, progress: (event) => progress.push(event) });
  await sweeper.sweep();
  expect(sweeper.facts.github.error).toBeUndefined();
  expect(sweeper.facts.radar.error).toBeUndefined();
  expect(sweeper.facts.runs.data?.["owner/partition"]?.integration).toEqual({
    sha: "integration",
    at: START,
  });
  expect(sweeper.cache.releases.pins).toHaveProperty("owner/partition@v1.0.0");
  expect(h.queries.filter((q) => q.includes("port_o0"))).toHaveLength(2);
  expect(sweeper.cache.budget.cost).toBe(h.costs.reduce((sum, cost) => sum + cost, 0));
  expect(sweeper.cache.budget.calls).toBe(h.costs.length);
  expect(sweeper.cache.budget.deferred).toEqual([]);
  const replay = createSweeper({
    ...h.options,
    exec: new ReplayExec(h.log.join("")),
    persist: { load: async () => undefined, save: async () => {} },
  });
  await replay.sweep();
  expect(replay.facts).toEqual(sweeper.facts);
  expect(replay.cache).toEqual(sweeper.cache);
  expect(replay.reads).toEqual(sweeper.reads);
  expect(replay.model).toEqual(sweeper.model);
  expect(progress.length).toBeGreaterThan(0);
});

test.each(["read", "deferred", "throttled"] as const)(
  "a factory hook throwing on every event cannot change a %s sweep",
  async (outcome) => {
    const run = async (progress?: (event: SweepProgress) => void) => {
      const h = harness("owner/partition", outcome === "deferred" ? 50 : 4000);
      if (outcome === "throttled")
        h.setRoute((cmd, args) =>
          cmd === "gh" && args.some((arg) => arg.startsWith("query="))
            ? {
                stdout: JSON.stringify({ message: "Retry after 600 seconds." }),
                stderr: "gh: HTTP 429\n",
                exit: 1,
              }
            : undefined,
        );
      let saved: unknown;
      const sweeper = createSweeper({
        ...h.options,
        progress,
        persist: {
          ...h.options.persist,
          save: async (state) => {
            saved = structuredClone(state);
            await h.options.persist.save(state);
          },
        },
      });
      const first = await sweeper.sweep();
      h.advance(1);
      const second = await sweeper.sweep();
      return {
        results: [first, second],
        facts: sweeper.facts,
        cache: sweeper.cache,
        reads: sweeper.reads,
        model: sweeper.model,
        saved,
      };
    };
    const baseline = await run();
    const events: SweepProgress[] = [];
    expect(
      await run((event) => {
        events.push(event);
        throw new Error("observer failed");
      }),
    ).toEqual(baseline);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "source", source: "releases", state: outcome }),
    );
    if (outcome === "read")
      expect(events).toContainEqual(expect.objectContaining({ state: "skipped" }));
    if (outcome === "throttled")
      expect(events).toContainEqual(expect.objectContaining({ kind: "throttle" }));
  },
);

test.each(["gh", "glab"] as const)(
  "the factory identifies %s sign-in failures from status, not text",
  async (tool) => {
    const h = harness();
    h.setRoute((cmd, args) =>
      cmd === tool && args[0] === "auth"
        ? { stdout: "opaque status", stderr: "opaque status", exit: 1 }
        : undefined,
    );
    const events: SweepProgress[] = [];
    const sweeper = createSweeper({ ...h.options, progress: (event) => events.push(event) });
    await sweeper.sweep();
    expect(
      events.find(
        (event) => event.kind === "source" && event.source === "auth" && event.state === "failed",
      ),
    ).toMatchObject({ code: "signin", reason: sweeper.facts.auth.data?.[tool].detail });
    for (const source of ["upstream", "radar"]) {
      expect(events).toContainEqual(
        expect.objectContaining({ kind: "source", source, state: "read" }),
      );
    }
  },
);

test.each([
  {
    state: "missing",
    failure: { stdout: "", stderr: "", exit: null, error: "spawn glab ENOENT" },
  },
  {
    state: "signed out",
    failure: { stdout: "", stderr: "opaque status or API failure", exit: 1 },
  },
])("GitLab source failures carry signin when glab is $state, then recover", async ({ failure }) => {
  const h = harness();
  h.setRoute((cmd) => (cmd === "glab" ? failure : undefined));
  const events: SweepProgress[] = [];
  const sweeper = createSweeper({ ...h.options, progress: (event) => events.push(event) });
  await sweeper.sweep();
  expect(sweeper.facts.auth.data?.gh.ok).toBe(true);
  expect(sweeper.facts.auth.data?.glab.ok).toBe(false);
  for (const source of ["auth", "upstream", "radar"]) {
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "source",
        source,
        state: "failed",
        code: "signin",
      }),
    );
  }
  expect(sweeper.facts.github.error).toBeUndefined();
  h.setRoute(undefined);
  events.length = 0;
  await sweeper.sweep({ force: true });
  for (const source of ["auth", "upstream", "radar"]) {
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "source", source, state: "read" }),
    );
    expect(events).not.toContainEqual(expect.objectContaining({ source, code: "signin" }));
  }
  h.setRoute((cmd, args) =>
    cmd === "glab" && args[0] !== "auth"
      ? { stdout: "", stderr: "GitLab unavailable", exit: 1 }
      : undefined,
  );
  events.length = 0;
  await sweeper.sweep({ force: true });
  for (const source of ["upstream", "radar"]) {
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "source", source, state: "failed", code: "other" }),
    );
  }
});

test.each(["timeout", "signed in"] as const)(
  "GitLab failures stay other when glab status is %s, regardless of API error prose",
  async (state) => {
    const h = harness();
    h.setRoute((cmd, args) => {
      if (cmd !== "glab") return undefined;
      if (args[0] === "auth")
        return state === "signed in"
          ? undefined
          : { stdout: "", stderr: "", exit: null, error: "Command timed out after 15000ms." };
      return { stdout: "", stderr: "sign in or retry after a timeout", exit: 1 };
    });
    const events: SweepProgress[] = [];
    await createSweeper({ ...h.options, progress: (event) => events.push(event) }).sweep();
    for (const source of ["upstream", "radar"]) {
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "source",
          source,
          state: "failed",
          code: "other",
        }),
      );
    }
  },
);

test("an unclassified auth transport failure reports other instead of guessing signin", async () => {
  const h = harness();
  h.setRoute((cmd, args) =>
    cmd === "gh" && args[0] === "auth"
      ? { stdout: "", stderr: "", exit: null, error: "sign in or retry after a timeout" }
      : undefined,
  );
  const events: SweepProgress[] = [];
  await createSweeper({ ...h.options, progress: (event) => events.push(event) }).sweep();
  expect(
    events.find(
      (event) => event.kind === "source" && event.source === "auth" && event.state === "failed",
    ),
  ).toMatchObject({ code: "other", reason: "sign in or retry after a timeout" });
});

test.each(["gh", "glab"] as const)(
  "the auth reason names %s when its sign-in fails and the other tool has a transport error",
  async (tool) => {
    const h = harness();
    h.setRoute((cmd, args) => {
      if (args[0] !== "auth") return undefined;
      return cmd === tool
        ? { stdout: "opaque status", stderr: "opaque status", exit: 1 }
        : { stdout: "", stderr: "", exit: null, error: `${cmd} transport unavailable` };
    });
    const calls: SweepProgress[] = [];
    const sweeper = createSweeper({ ...h.options, progress: (event) => calls.push(event) });
    await sweeper.sweep();
    expect(
      calls.find(
        (event) => event.kind === "source" && event.source === "auth" && event.state === "failed",
      ),
    ).toMatchObject({ code: "signin", reason: sweeper.facts.auth.data?.[tool].detail });
    expect(sweeper.reads.auth?.find((record) => record.source !== tool)?.failure).toContain(
      "transport unavailable",
    );
  },
);

test.each(["cut", "failed", "throttled"] as const)(
  "mixed release reads expose state-appropriate incomplete counts for %s reads",
  async (state) => {
    const h = harness();
    const initial = createSweeper(h.options);
    await initial.sweep();
    const saved = structuredClone({
      facts: initial.facts,
      cache: initial.cache,
      reads: initial.reads,
    });
    saved.cache.releases.records = saved.cache.releases.records.map((record) =>
      record.source === "github-pins"
        ? {
            ...record,
            completeness: { kind: "cut", reason: "page limit", read: 1, total: 2 },
          }
        : record,
    );
    if (state === "failed")
      h.setRoute((cmd, args) =>
        cmd === "gh" && args.some((arg) => arg.startsWith("repos/owner/partition/releases?"))
          ? { stdout: "", stderr: "releases unavailable", exit: 1 }
          : undefined,
      );
    if (state === "throttled")
      h.setRoute((cmd, args) =>
        cmd === "gh" &&
        args.some((arg) => arg.startsWith("query=") && arg.includes("{ createdAt }"))
          ? {
              stdout: JSON.stringify({ message: "Retry after 600 seconds." }),
              stderr: "gh: HTTP 429\n",
              exit: 1,
            }
          : undefined,
      );
    const calls: SweepProgress[] = [];
    const sweeper = createSweeper({
      ...h.options,
      persist: { ...h.options.persist, load: async () => structuredClone(saved) },
      progress: (event) => calls.push(event),
    });
    await sweeper.sweep({ force: true });
    const records = sweeper.cache.releases.records;
    expect(records.filter((record) => record.completeness.kind === "cut")).toHaveLength(1);
    const outcome = calls.find(
      (event) =>
        event.kind === "source" &&
        event.source === "releases" &&
        event.state === (state === "failed" ? "cut" : state),
    );
    expect(outcome).toBeDefined();
    if (state === "cut")
      expect(outcome).toMatchObject({ incomplete: { count: 1, total: records.length } });
    else if (state === "failed")
      expect(outcome).toMatchObject({
        incomplete: { count: 1, total: records.length },
        failed: { count: 1, services: ["partition"] },
      });
    else {
      expect(records.some((record) => record.failure !== undefined)).toBe(true);
      expect(outcome).not.toHaveProperty("incomplete");
    }
  },
);

test("the collector reports releases in sweep order, including cadence skips and failed reads", async () => {
  const h = harness();
  const calls: SweepProgress[] = [];
  const sweeper = createSweeper({ ...h.options, progress: (event) => calls.push(event) });
  await sweeper.sweep();
  expect(
    calls
      .filter((event) => event.kind === "source" && event.state === "reading")
      .map((event) => event.kind === "source" && event.source),
  ).toEqual([
    "auth",
    "fleet",
    "github",
    "runs",
    "approvals",
    "lifecycle",
    "template",
    "details",
    "upstream",
    "radar",
    "security",
    "releases",
  ]);
  expect(calls.filter((event) => event.kind === "source").slice(-2)).toEqual([
    { kind: "source", source: "releases", state: "reading", startedAt: START },
    {
      kind: "source",
      source: "releases",
      state: "read",
      endedAt: START,
      completeness: { kind: "complete" },
    },
  ]);
  calls.length = 0;
  await sweeper.sweep();
  expect(calls.filter((event) => event.kind === "source" && event.state === "skipped")).toEqual(
    ["upstream", "radar", "security", "releases"].map((source) => ({
      kind: "source",
      source,
      state: "skipped",
      endedAt: START,
      reason: "not due",
      code: "cadence",
    })),
  );
  h.setRoute((cmd, args) =>
    cmd === "gh" && args.some((arg) => arg.includes("/releases?"))
      ? { stdout: "", stderr: "releases unavailable", exit: 1 }
      : undefined,
  );
  calls.length = 0;
  await sweeper.sweep({ force: true });
  expect(calls.filter((event) => event.kind === "source").slice(-2)).toEqual([
    { kind: "source", source: "releases", state: "reading", startedAt: START },
    {
      kind: "source",
      source: "releases",
      state: "cut",
      endedAt: START,
      completeness: { kind: "complete" },
      incomplete: { count: 0, total: sweeper.cache.releases.records.length },
      failed: {
        count: sweeper.cache.releases.records.filter((record) => record.failure).length,
        services: [],
      },
    },
  ]);
  h.setRoute((cmd, args) =>
    cmd === "gh" && args.some((arg) => arg.startsWith("query=") && arg.includes("{ createdAt }"))
      ? {
          stdout: JSON.stringify({ message: "Retry after 600 seconds." }),
          stderr: "gh: HTTP 429\n",
          exit: 1,
        }
      : undefined,
  );
  calls.length = 0;
  await sweeper.sweep({ force: true });
  expect(calls.filter((event) => event.kind === "source").slice(-2)).toEqual([
    { kind: "source", source: "releases", state: "reading", startedAt: START },
    {
      kind: "source",
      source: "releases",
      state: "throttled",
      endedAt: START,
      reason: sweeper.cache.releases.records.find((record) => record.failure)?.failure,
      code: "throttled",
      completeness: { kind: "complete" },
      resumeAt: "2026-10-14T00:10:00.000Z",
    },
  ]);
});

test.each(["fleet", "releases"] as const)(
  "the factory reports %s's live throttle before its wait completes even if the hook throws",
  async (source) => {
    const h = harness();
    const calls: SweepProgress[] = [];
    let limited = false;
    h.setRoute((cmd, args) => {
      const marker = source === "fleet" ? "stack: repository" : "{ createdAt }";
      if (
        limited ||
        cmd !== "gh" ||
        !args.some((arg) => arg.startsWith("query=") && arg.includes(marker))
      )
        return undefined;
      limited = true;
      return {
        stdout: JSON.stringify({ message: "Retry after 30 seconds." }),
        stderr: "gh: HTTP 429\n",
        exit: 1,
      };
    });
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sleeping = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const budget = new GraphqlBudget(h.options.ctx.clock, async (ms) => {
      expect(ms).toBe(30_000);
      entered?.();
      await waiting;
      h.advance(ms);
    });
    const sweeper = createSweeper({
      ...h.options,
      budget,
      progress: (event) => {
        calls.push(event);
        throw new Error("observer failed");
      },
    });
    const pending = sweeper.sweep();
    await sleeping;
    try {
      expect(calls.filter((event) => event.kind === "throttle")).toEqual([
        {
          kind: "throttle",
          source,
          code: "throttled",
          reason: "Retry after 30 seconds.",
          resumeAt: "2026-10-14T00:00:30.000Z",
        },
      ]);
      expect(calls.filter((event) => event.kind === "source" && event.source === source)).toEqual([
        { kind: "source", source, state: "reading", startedAt: START },
      ]);
      expect(sweeper.sweeping).toBe(true);
    } finally {
      release?.();
      await pending;
    }
    expect(
      calls.filter((event) => event.kind === "source" && event.source === source).at(-1),
    ).toMatchObject({ state: "read", endedAt: "2026-10-14T00:00:30.000Z" });
    expect(sweeper.cache.budget.deferred).toEqual([]);
  },
);

test("a low budget defers every GitHub read but auth until the reset; an unknown budget runs core reads", async () => {
  const low = harness("owner/partition", 50);
  const gh: string[] = [];
  low.setRoute((cmd, args) => {
    if (cmd === "gh") gh.push(args.join(" "));
    return undefined;
  });
  const calls: SweepProgress[] = [];
  const sweeper = createSweeper({ ...low.options, progress: (event) => calls.push(event) });
  const github = ["github", "runs", "approvals", "lifecycle", "template", "details"];
  const optional = ["radar", "security", "releases"];
  const deferred = (sources: readonly string[]) => {
    expect(sweeper.cache.budget.deferred).toEqual(
      sources.map((area) => ({ area, reason: "insufficient budget" })),
    );
    expect(calls.filter((event) => event.kind === "source" && event.state === "deferred")).toEqual(
      sources.map((source) => ({
        kind: "source",
        source,
        state: "deferred",
        endedAt: START,
        reason: "insufficient budget",
        code: "budget",
        resumeAt: "2099-01-01T00:00:00Z",
      })),
    );
    expect(calls.filter((event) => event.kind === "source" && event.state === "failed")).toEqual(
      [],
    );
    calls.length = 0;
  };
  // The first sweep has no budget yet, so fleet reads and reports the 50 points left.
  await sweeper.sweep();
  expect(sweeper.facts.fleet.data).toBeDefined();
  expect(sweeper.facts.github.data).toBeUndefined();
  expect(sweeper.facts.auth.data?.gh.ok).toBe(true);
  expect(sweeper.facts.upstream.data?.partition).toBeDefined();
  deferred([...github, ...optional]);
  for (const force of [false, true]) {
    gh.length = 0;
    await sweeper.sweep({ force });
    // Only the auth area touches GitHub: its status check and the login it reads.
    expect(gh).toEqual(["auth status --hostname github.com", "api user --jq .login"]);
    deferred(["fleet", ...github, ...optional]);
  }
  low.setRoute(undefined);
  low.setOffline();
  calls.length = 0;
  const cold = createSweeper({
    ...low.options,
    progress: (event) => calls.push(event),
    persist: { load: async () => undefined, save: async () => {} },
  });
  await cold.sweep({ force: true });
  expect(cold.cache.budget.deferred).toEqual(
    ["details", "radar", "security", "releases"].map((area) => ({
      area,
      reason: "budget unknown",
    })),
  );
  expect(calls.filter((event) => event.kind === "source" && event.state === "deferred")).toEqual(
    ["details", "radar", "security", "releases"].map((source) => ({
      kind: "source",
      source,
      state: "deferred",
      endedAt: START,
      reason: "budget unknown",
      code: "budget",
    })),
  );
  expect(cold.facts.github.error).toContain("gh");
  expect(cold.facts.auth.data?.gh.ok).toBe(false);
  expect(cold.model.measured).toBe(false);
  expect(cold.facts.sweep?.errors).toBeGreaterThan(0);
});

test("cadences include the exact boundary, force and missing-fork retry", async () => {
  for (const interval of [GITLAB_EVERY_MS, SECURITY_EVERY_MS, RELEASES_EVERY_MS]) {
    expect(due(START, interval, new Date(Date.parse(START) + interval - 1))).toBe(false);
    expect(due(START, interval, new Date(Date.parse(START) + interval))).toBe(true);
    expect(due(START, interval, new Date(START), true)).toBe(true);
  }
  const h = harness();
  const sweeper = createSweeper(h.options);
  await sweeper.sweep();
  const upstream = sweeper.facts.upstream.at;
  const radar = sweeper.facts.radar.at;
  h.advance(1);
  await sweeper.sweep();
  expect(sweeper.facts.upstream.at).toBe(upstream);
  expect(sweeper.facts.radar.at).toBe(radar);
  delete sweeper.facts.upstream.data?.partition;
  await sweeper.sweep();
  expect(sweeper.facts.upstream.at).not.toBe(upstream);
  expect(sweeper.facts.radar.at).not.toBe(radar);
  const retried = sweeper.facts.upstream.at;
  h.advance(GITLAB_EVERY_MS - 1);
  await sweeper.sweep();
  expect(sweeper.facts.upstream.at).toBe(retried);
  expect(sweeper.facts.security.at).toBe(h.options.ctx.clock.now().toISOString());
  h.advance(1);
  await sweeper.sweep();
  expect(sweeper.facts.upstream.at).toBe(h.options.ctx.clock.now().toISOString());
  h.advance(RELEASES_EVERY_MS - GITLAB_EVERY_MS - 1);
  await sweeper.sweep();
  expect(sweeper.cache.releases.at).toBe(h.options.ctx.clock.now().toISOString());
});

test("two interleaved fleets keep facts, caches and budgets independent", async () => {
  const a = harness("owner/one");
  const b = harness("owner/two", 50);
  const one = createSweeper(a.options);
  const two = createSweeper(b.options);
  await Promise.all([one.sweep(), two.sweep()]);
  const budget = structuredClone(two.cache.budget);
  a.advance(1);
  await one.sweep({ force: true });
  expect(Object.keys(one.facts.runs.data ?? {})).toEqual(["owner/one"]);
  // Fleet two sits below the budget floor, so its runs wait for the reset.
  expect(two.facts.runs.data).toBeUndefined();
  expect(one.cache.radar.pins.forks).toHaveProperty("owner/one:main:pom.xml");
  expect(Object.keys(two.cache.radar.pins.forks)).toEqual([]);
  expect(one.cache.budget.deferred).toEqual([]);
  expect(two.cache.budget).toEqual(budget);
});

test("a fleet without the core library makes no release reads for it; the default fleet does", async () => {
  const library = (log: readonly string[]) =>
    log.filter((line) => line.includes(shortRepo(CORE_LIB_REPO)));
  const standard = harness();
  expect(standard.options.ctx.fleet.releaseRepos).toContain(CORE_LIB_REPO);
  await createSweeper(standard.options).sweep();
  expect(library(standard.log).length).toBeGreaterThan(0);

  const without = harness();
  const fleet = fleetOf(without.options.ctx.fleet.services, STACK_REPO, null);
  const sweeper = createSweeper({
    ...without.options,
    ctx: createContext({ ...without.options.ctx, fleet }),
  });
  await sweeper.sweep();
  expect(sweeper.cache.releases.at).toBe(START);
  expect(sweeper.cache.releases.releases).toHaveProperty("owner/partition");
  expect(library(without.log)).toEqual([]);
});

test("sweeper fleet reads and pruning use its context stack after fleet context rebuilding", async () => {
  const runs = ["one", "two"].map((owner, i) => {
    const h = harness(`owner/fork${i}`);
    const sweeper = createSweeper({
      ...h.options,
      ctx: createContext({ ...h.options.ctx, stackRepo: `${owner}/environment` }),
    });
    return { owner, h, sweeper };
  });
  await Promise.all(runs.map(({ sweeper }) => sweeper.sweep()));
  for (const { owner, h, sweeper } of runs) {
    const stackRepo = `${owner}/environment`;
    const declaration = h.queries.find((q) => q.includes("stack: repository"));
    expect(declaration).toContain(`stack: repository(owner: "${owner}", name: "environment")`);
    const job = { id: 9, name: "Deploy", status: "completed", url: "u", steps: [] };
    sweeper.facts.lifecycle.data = {
      refresh: [
        {
          id: 7,
          name: "Refresh",
          path: "env-refresh.yml",
          event: "workflow_dispatch",
          status: "completed",
          createdAt: START,
          updatedAt: START,
          sha: "abc",
          title: "Refresh",
          url: "u",
          attempt: 1,
          kind: "refresh",
          jobs: [job],
        },
      ],
      upgrade: [],
      smoke: [],
      sweeper: [],
    };
    sweeper.cache.details[`${stackRepo}#9`] = {
      data: job,
      reads: [
        {
          source: "github",
          object: `repos/${stackRepo}/actions/jobs/9`,
          observedAt: START,
          completeness: { kind: "complete" },
        },
      ],
    };
    sweeper.prune();
    expect(sweeper.cache.details[`${stackRepo}#9`]?.data).toEqual(job);
    expect(sweeper.model.work.stack.repo).toBe(stackRepo);
  }
});

test("a total outage keeps last-good radar and per-fork/approval evidence through repeated sweeps", async () => {
  const h = harness();
  const sweeper = createSweeper(h.options);
  await sweeper.sweep();
  const radar = structuredClone(sweeper.facts.radar);
  const reads = structuredClone(sweeper.reads);
  h.setOffline();
  for (let i = 0; i < 2; i++) {
    h.advance(60_000);
    await sweeper.sweep({ force: true });
    expect(sweeper.facts.radar.data).toEqual(radar.data);
    expect(sweeper.facts.radar.at).toBe(radar.at);
    expect(sweeper.facts.radar.error).toContain("glab");
    for (const area of ["runs", "approvals"] as const) {
      expect(sweeper.reads[area]?.[0]?.retainedFrom).toBe(reads[area]?.[0]?.observedAt);
    }
  }
});

test("snapshot replay performs no reads or writes and keeps recorded envelopes", async () => {
  const h = harness();
  const facts = emptyFacts();
  facts.sweep = { at: START, calls: 17, errors: 0, ms: 42 };
  facts.github = { at: START, data: { repos: {}, planned: { recorded: true } } };
  const frame: SweepState<ReturnType<typeof emptyCache>> = {
    facts,
    cache: emptyCache(),
    reads: {
      github: [
        {
          source: "github",
          object: "recorded",
          observedAt: START,
          completeness: { kind: "cut", read: 1, total: 2, reason: "recorded cut" },
        },
      ],
    },
  };
  const sweeper = createSweeper({
    ...h.options,
    replay: async () => frame,
    persist: {
      load: async () => undefined,
      save: async () => {
        throw new Error("must not save");
      },
    },
  });
  await sweeper.sweep();
  expect(h.log).toHaveLength(0);
  expect(sweeper.facts).toEqual(frame.facts);
  expect(sweeper.reads).toEqual(frame.reads);
});

test("cut run-job listings are retried until the Java Build is observed", async () => {
  const h = harness();
  let complete = false;
  let calls = 0;
  const job = (id: number, name: string) => ({
    id,
    name,
    status: "completed",
    conclusion: "success",
    started_at: START,
    completed_at: START,
    html_url: "u",
    steps: [],
    run_attempt: 1,
  });
  h.setRoute((_cmd, args) => {
    const path = args[1] ?? "";
    if (!path.includes("/attempts/1/jobs?")) return;
    calls++;
    return {
      stdout: JSON.stringify({
        total: 2,
        jobs: complete ? [job(1, "Prepare"), job(2, "Java Build")] : [job(1, "Prepare")],
      }),
      stderr: "",
      exit: 0,
    };
  });
  const sweeper = createSweeper(h.options);
  await sweeper.sweep();
  expect(
    sweeper.cache.lifecycle.runJobs["5#1"]?.reads.some((r) => r.completeness.kind === "cut"),
  ).toBe(true);
  const before = calls;
  complete = true;
  await sweeper.sweep();
  expect(calls).toBeGreaterThan(before);
  expect(
    sweeper.facts.runs.data?.["owner/partition"]?.cascadeRunJobs?.[5]?.map((j) => j.name),
  ).toContain("Java Build");
  const settled = calls;
  await sweeper.sweep();
  expect(calls).toBe(settled);
});

test("a run whose only cut is an over-limit job log settles and is not re-listed", async () => {
  const h = harness();
  let listings = 0;
  h.setRoute((_cmd, args) => {
    const path = args[1] ?? "";
    if (path.includes("/attempts/1/jobs?")) {
      listings++;
      return {
        stdout: JSON.stringify({
          total: 1,
          jobs: [
            {
              id: 9,
              name: "Java Build",
              status: "completed",
              conclusion: "failure",
              started_at: START,
              completed_at: START,
              html_url: "u",
              steps: [],
              run_attempt: 1,
            },
          ],
        }),
        stderr: "",
        exit: 0,
      };
    }
    const all = args.join(" ");
    if (all.includes("/check-runs/9/annotations")) return { stdout: "", stderr: "", exit: 0 };
    if (all.includes("/jobs/9/logs")) return { stdout: "x".repeat(70_000), stderr: "", exit: 0 };
  });
  const progress: SweepProgress[] = [];
  const sweeper = createSweeper({ ...h.options, progress: (event) => progress.push(event) });
  await sweeper.sweep();
  expect(
    sweeper.cache.lifecycle.runJobs["5#1"]?.reads.some(
      (r) => r.completeness.kind === "cut" && r.completeness.reason === "Job log character limit",
    ),
  ).toBe(true);
  expect(
    progress.find(
      (event) => event.kind === "source" && event.source === "runs" && event.state === "cut",
    ),
  ).toMatchObject({
    incomplete: { count: 1, total: sweeper.reads.runs?.length },
    completeness: { kind: "cut", reason: "Job log character limit", read: 64_000, total: 70_000 },
  });
  const settled = listings;
  await sweeper.sweep();
  await sweeper.sweep();
  expect(listings).toBe(settled);
});

test("a permanently failing upstream retries only that fork without rerunning radar before cadence", async () => {
  const h = harness();
  const branches: string[] = [];
  let radarLists = 0;
  h.setRoute((cmd, args) => {
    const query = args.find((a) => a.startsWith("query=")) ?? "";
    if (cmd === "gh" && query.includes("stack: repository"))
      return {
        stdout: JSON.stringify({
          data: {
            stack: {
              object: {
                text: "forks:\n  - service: partition\n    repo: owner/partition\n  - service: storage\n    repo: owner/storage\n",
              },
            },
            template: { object: null },
            spicodeBudget: { cost: 2, remaining: 4000, resetAt: "2099-01-01T00:00:00Z" },
          },
        }),
        stderr: "",
        exit: 0,
      };
    const path = args.at(-1) ?? "";
    if (cmd === "glab" && path.includes("merge_requests?state=opened")) radarLists++;
    if (cmd === "glab" && path.includes("/repository/branches/")) {
      branches.push(path);
      if (path.includes(encodeURIComponent("osdu/platform/system/storage")))
        return { stdout: "", stderr: "storage unavailable", exit: 1 };
    }
  });
  const sweeper = createSweeper(h.options);
  await sweeper.sweep();
  const failed = sweeper.reads.upstream?.find((r) => r.failure)?.source;
  expect(failed).toBeDefined();
  const goodReads = structuredClone(sweeper.reads.upstream?.filter((r) => !r.failure));
  const radar = structuredClone(sweeper.facts.radar);
  const initialLists = radarLists;
  expect(initialLists).toBeGreaterThan(0);
  branches.length = 0;
  const resumed = createSweeper(h.options);
  for (let i = 0; i < 2; i++) {
    h.advance(1);
    await resumed.sweep();
    expect(resumed.facts.radar).toEqual(radar);
    expect(resumed.reads.upstream?.filter((r) => !r.failure)).toEqual(goodReads);
  }
  expect(branches).toHaveLength(2);
  expect(branches.every((path) => path.includes(encodeURIComponent(failed ?? "")))).toBe(true);
  expect(radarLists).toBe(initialLists);
  branches.length = 0;
  h.advance(GITLAB_EVERY_MS - 2);
  await resumed.sweep();
  expect(branches).toHaveLength(2);
  expect(radarLists).toBeGreaterThan(initialLists);
});

test("forks dropped from the declaration leave the upstream data and reads", async () => {
  const h = harness();
  let forks =
    "  - service: partition\n    repo: owner/partition\n  - service: storage\n    repo: owner/storage\n";
  h.setRoute((cmd, args) => {
    const query = args.find((a) => a.startsWith("query=")) ?? "";
    if (cmd === "gh" && query.includes("stack: repository"))
      return {
        stdout: JSON.stringify({
          data: {
            stack: { object: { text: `forks:\n${forks}` } },
            template: { object: null },
            spicodeBudget: { cost: 2, remaining: 4000, resetAt: "2099-01-01T00:00:00Z" },
          },
        }),
        stderr: "",
        exit: 0,
      };
  });
  const sweeper = createSweeper(h.options);
  await sweeper.sweep();
  const storage = sweeper.facts.radar.data?.services.storage?.project;
  expect(storage).toBeDefined();
  expect(sweeper.facts.upstream.data?.storage).toBeDefined();
  expect(sweeper.reads.upstream?.some((r) => r.source === storage)).toBe(true);
  forks = "  - service: partition\n    repo: owner/partition\n";
  h.advance(1);
  await sweeper.sweep({ force: true });
  expect(Object.keys(sweeper.facts.upstream.data ?? {})).toEqual(["partition"]);
  expect(sweeper.reads.upstream?.some((r) => r.source === storage)).toBe(false);
});

test("partial upstream failures retain queued commits and retry the failed fork before cadence", async () => {
  const h = harness();
  let failedProject: string | undefined;
  let fail = true;
  let retries = 0;
  h.setRoute((cmd, args) => {
    const query = args.find((a) => a.startsWith("query=")) ?? "";
    if (cmd === "gh" && query.includes("stack: repository"))
      return {
        stdout: JSON.stringify({
          data: {
            stack: {
              object: {
                text: "forks:\n  - service: partition\n    repo: owner/partition\n  - service: storage\n    repo: owner/storage\n",
              },
            },
            template: { object: null },
            spicodeBudget: { cost: 2, remaining: 4000, resetAt: "2099-01-01T00:00:00Z" },
          },
        }),
        stderr: "",
        exit: 0,
      };
    const path = args.at(-1) ?? "";
    if (
      failedProject &&
      path.includes(encodeURIComponent(failedProject)) &&
      path.includes("/repository/branches/")
    ) {
      retries++;
      if (fail) return { stdout: "", stderr: "storage unavailable", exit: 1 };
    }
  });
  const sweeper = createSweeper(h.options);
  await sweeper.sweep();
  const old = sweeper.facts.upstream.data?.storage;
  if (!old) throw new Error("storage was not read");
  old.commits = [{ sha: "queued", title: "Queued", at: START, url: "u" }];
  const good = structuredClone(old);
  failedProject = sweeper.facts.radar.data?.services.storage?.project;
  expect(failedProject).toBeDefined();
  for (let i = 0; i < 2; i++) {
    h.advance(1);
    await sweeper.sweep({ force: i === 0 });
    expect(sweeper.facts.upstream.data?.storage).toEqual(good);
    expect(sweeper.reads.upstream?.find((r) => r.source === failedProject)).toMatchObject({
      failure: expect.stringContaining("storage unavailable"),
      retainedFrom: START,
    });
    expect(sweeper.facts.radar.data?.services.storage?.queued[0]?.sha).toBe("queued");
    const fresh = sweeper.reads.upstream?.find((r) => r.source !== failedProject);
    expect(fresh?.failure).toBeUndefined();
    expect(fresh?.retainedFrom).toBeUndefined();
  }
  expect(retries).toBe(2);
  fail = false;
  h.advance(1);
  await sweeper.sweep();
  expect(retries).toBe(3);
  expect(sweeper.reads.upstream?.find((r) => r.source === failedProject)?.failure).toBeUndefined();
  expect(sweeper.facts.upstream.data?.storage?.commits).toEqual([]);
  expect(sweeper.facts.radar.data?.services.storage?.queued).toEqual([]);
  expect(sweeper.facts.radar.at).toBe(h.options.ctx.clock.now().toISOString());
});

test("shared budget accounts attribute interleaved sweeps only their own GraphQL charges", async () => {
  const a = harness("owner/one");
  const b = harness("owner/two");
  const budget = new GraphqlBudget(a.options.ctx.clock);
  const one = createSweeper({ ...a.options, budget });
  const two = createSweeper({ ...b.options, budget });
  await Promise.all([one.sweep(), two.sweep()]);
  expect(one.cache.budget.cost).toBe(a.costs.reduce((sum, cost) => sum + cost, 0));
  expect(two.cache.budget.cost).toBe(b.costs.reduce((sum, cost) => sum + cost, 0));
  expect(one.cache.budget.calls).toBe(a.costs.length);
  expect(two.cache.budget.calls).toBe(b.costs.length);
  expect(budget.snapshot().spent).toBe(one.cache.budget.cost + two.cache.budget.cost);
  const costs = a.costs.length;
  await one.sweep({ force: true });
  expect(one.cache.budget.cost).toBe(a.costs.slice(costs).reduce((sum, cost) => sum + cost, 0));
});

test("failed detail rereads retain only their previous job and observation", async () => {
  const h = harness();
  const sweeper = createSweeper(h.options);
  await sweeper.sweep();
  const repo = "owner/partition";
  const entry = sweeper.facts.github.data?.repos[repo];
  if (!entry) throw new Error("missing repository");
  entry.prs = [
    {
      repo,
      number: 1,
      title: "Failing PR",
      url: "u",
      createdAt: START,
      updatedAt: START,
      draft: false,
      head: "feature",
      base: "main",
      headSha: "sha",
      labels: [],
      checks: [901, 902].map((id) => ({
        id,
        name: `Check ${id}`,
        workflow: "CI",
        status: "COMPLETED",
        conclusion: "FAILURE",
      })),
    },
  ];
  const job = { id: 901, name: "Check 901", status: "in_progress", url: "u", steps: [] };
  sweeper.facts.details.data = { [`${repo}#901`]: job };
  sweeper.reads.details = [
    {
      source: "github",
      object: `repos/${repo}/actions/jobs/901`,
      observedAt: START,
      completeness: { kind: "complete" },
    },
  ];
  h.setRoute((_cmd, args) => {
    if (args.some((a) => a.startsWith("query=") && /r_(template|fork0):/.test(a)))
      return { stdout: "", stderr: "github unavailable", exit: 1 };
    if (args[1]?.endsWith("/actions/jobs/901"))
      return { stdout: "", stderr: "job unavailable", exit: 1 };
    if (args[1]?.endsWith("/actions/jobs/902"))
      return {
        stdout: JSON.stringify({
          id: 902,
          name: "Check 902",
          status: "completed",
          conclusion: "success",
          started_at: START,
          completed_at: START,
          html_url: "u",
          steps: [],
        }),
        stderr: "",
        exit: 0,
      };
  });
  h.advance(1);
  await sweeper.sweep();
  expect(sweeper.facts.details.data?.[`${repo}#901`]).toEqual(job);
  expect(sweeper.facts.details.data?.[`${repo}#902`]?.id).toBe(902);
  expect(sweeper.reads.details?.find((r) => r.object.endsWith("/901"))).toMatchObject({
    retainedFrom: START,
    failure: expect.stringContaining("job unavailable"),
  });
});

test("an auth exception cannot accumulate deferred entries across sweeps", async () => {
  const h = harness("owner/partition", 50);
  let throwAuth = false;
  const sweeper = createSweeper({
    ...h.options,
    exec: {
      runJSON: h.options.exec.runJSON.bind(h.options.exec),
      runText: async (...args) => {
        if (throwAuth && args[1][0] === "auth") throw new Error("auth transport failed");
        return h.options.exec.runText(...args);
      },
    },
  });
  // The first sweep learns the budget during fleet; the second defers from the start.
  await sweeper.sweep();
  await sweeper.sweep();
  const deferred = structuredClone(sweeper.cache.budget.deferred);
  throwAuth = true;
  await sweeper.sweep();
  expect(sweeper.facts.auth.error).toContain("auth transport failed");
  expect(sweeper.cache.budget.deferred).toEqual(deferred);
});

test("cache loading rejects malformed pin times and pruning bounds every collector cache", () => {
  const facts = emptyFacts();
  const cache = emptyCache();
  const read = {
    source: "github",
    object: "old",
    observedAt: START,
    completeness: { kind: "complete" as const },
  };
  cache.lifecycle.runJobs.old = { data: [], reads: [read] };
  cache.lifecycle.files.old = { data: "v1", reads: [read] };
  cache.approvals.old = { files: [], changedFiles: 0, additions: 0, deletions: 0 };
  const job = { id: 1, name: "job", status: "completed", url: "u", steps: [] };
  cache.details["repo#1"] = { data: job, reads: [read] };
  cache.details["repo#2"] = { data: { ...job, id: 2 }, reads: [read] };
  facts.details.data = { "repo#1": job };
  for (let i = 0; i < 210; i++) cache.radar.commitDiffs[String(i)] = { paths: [] };
  cache.radar.pins.latestAt = "bad";
  expect(cacheSchema.safeParse(cache).success).toBe(false);
  delete cache.radar.pins.latestAt;
  pruneCache(facts, cache, createContext());
  expect(cache.lifecycle.runJobs).toEqual({});
  expect(cache.lifecycle.files).toEqual({});
  expect(cache.approvals).toEqual({});
  expect(Object.keys(cache.details)).toEqual(["repo#1"]);
  expect(Object.keys(cache.radar.commitDiffs)).toHaveLength(200);
});

test("a GitHub throttle longer than the sweep may wait defers the remaining GraphQL areas with its reason", async () => {
  const h = harness();
  const throttled: string[] = [];
  h.setRoute((cmd, args) => {
    if (cmd !== "gh" || !args.some((a) => a.startsWith("query="))) return undefined;
    throttled.push(args.at(-1) ?? "");
    return {
      stdout: JSON.stringify({
        message: "You have exceeded a secondary rate limit. Retry after 600 seconds.",
      }),
      stderr: "gh: HTTP 403\n",
      exit: 1,
    };
  });
  const calls: SweepProgress[] = [];
  const sweeper = createSweeper({ ...h.options, progress: (event) => calls.push(event) });
  await sweeper.sweep();
  const reason = expect.stringMatching(
    /^GitHub throttled GraphQL until 2026-10-14T00:10:00\.000Z \(.*secondary rate limit/,
  );
  expect(sweeper.facts.fleet.error).toContain("throttled");
  expect(sweeper.cache.budget.deferred).toEqual([
    { area: "github", reason },
    { area: "details", reason },
    { area: "radar", reason },
    { area: "security", reason: "budget unknown" },
    { area: "releases", reason },
  ]);
  expect(calls.filter((event) => event.kind === "source" && event.state === "throttled")).toEqual(
    ["fleet", "github", "details", "radar", "releases"].map((source) => ({
      kind: "source",
      source,
      state: "throttled",
      endedAt: START,
      reason: source === "fleet" ? sweeper.facts.fleet.error : reason,
      code: "throttled",
      ...(source === "fleet" ? { completeness: { kind: "complete" } } : {}),
      resumeAt: "2026-10-14T00:10:00.000Z",
    })),
  );
  expect(throttled).toHaveLength(1);
});
