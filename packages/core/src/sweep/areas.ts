// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import { type FleetFileReader, type FleetFiles, type FleetView, fleetView, readFleet } from "../collect/fleet.js";
import { parseGithub } from "../collect/github-parse.js";
import { readGithub } from "../collect/github-read.js";
import { jobsKey, settledJobReads, readJob, readLifecycle, readRunJobs } from "../collect/lifecycle.js";
import { readRadar } from "../collect/radar.js";
import { ReleaseReader } from "../collect/releases.js";
import { readApprovals, readForkRuns } from "../collect/runs.js";
import { readSecurity } from "../collect/security.js";
import { readTemplate } from "../collect/template.js";
import { readUpstream } from "../collect/upstream.js";
import { fleetOf, GITLAB_EVERY_MS, RELEASES_EVERY_MS, SECURITY_EVERY_MS } from "../config.js";
import { type CoreContext, createContext } from "../context.js";
import { BudgetPacer, type ReadRecord } from "../evidence/index.js";
import type { AreaName, Facts, JobDetail } from "../facts.js";
import { ForgeError, Gh, Glab, GraphqlBudget, THROTTLE_WAIT_ALLOWANCE_MS } from "../forge.js";
import { failedChecks, javaBuilt } from "../model/checks.js";
import { errorText } from "../util.js";
import { type CollectorCache, cacheSchema, emptyCache, pruneCache } from "./cache.js";
import { due } from "./cadence.js";
import { collectorInflight } from "./inflight.js";
import {
  type SweepArea, type SweepInput, type SweepPersist, Sweeper, type SweepState,
  type SweepProgressHook, type SweepReadDecision, sweepFailureProgress, sweepReadProgress,
  type SweepSource,
  type SweepReasonCode,
} from "./sweeper.js";

export interface CollectorOptions {
  readonly ctx: CoreContext;
  readonly exec: SweepInput<CollectorCache>["exec"];
  readonly persist: SweepPersist<CollectorCache>;
  readonly factsSchema: z.ZodType<Facts>;
  readonly pacer?: BudgetPacer;
  readonly budget?: GraphqlBudget;
  readonly fleetFiles?: FleetFiles;
  readonly readFile?: FleetFileReader;
  readonly replay?: () => Promise<SweepState<CollectorCache>>;
  readonly progress?: SweepProgressHook;
}

// Failed subreads retain their own prior observation, never the area's newest timestamp.
function retain<T>(data: Record<string, T>, previous: Record<string, T> | undefined,
  reads: readonly ReadRecord[], prior: readonly ReadRecord[], key: (r: ReadRecord) => string) {
  const records = reads.map((r) => {
    if (!r.failure) return r;
    const id = key(r);
    if (previous?.[id] !== undefined) data[id] = previous[id];
    const last = prior.find((p) => p.source === r.source && p.object === r.object);
    const retainedFrom = previous?.[id] === undefined ? undefined
      : last?.retainedFrom ?? (last?.failure === undefined ? last?.observedAt : undefined);
    return { ...r, ...(retainedFrom ? { retainedFrom } : {}) };
  });
  return { data, reads: records };
}

export function createSweeper(options: CollectorOptions): Sweeper<CollectorCache> {
  let readingSource: SweepSource | undefined;
  let notify: SweepProgressHook | undefined;
  const account = (options.budget ?? new GraphqlBudget(options.ctx.clock)).scope(
    options.progress ? (event) => {
      if (readingSource !== undefined)
        notify?.({ kind: "throttle", source: readingSource, code: "throttled", ...event });
    } : undefined,
  );
  const pacer = options.pacer ?? new BudgetPacer({ floor: 100, resetBudget: 5000 });
  let baseline = account.snapshot();
  let upstreamChanged = false;
  let glabNeedsReadiness = false;
  let view: FleetView | undefined;
  const areas: SweepArea<CollectorCache>[] = [];
  type Input = SweepInput<CollectorCache>;
  function upstreamForks({ ctx, facts, reads, clock, force }: Input) {
    return ctx.fleet.forks.filter((fork) => {
      const records = reads.upstream?.filter((r) => r.source === fork.upstream);
      const branch = records?.find((r) => r.object === "repository/branches/master");
      return !facts.upstream.data?.[fork.id] || records?.some((r) => r.failure) ||
        due(branch?.observedAt ?? facts.upstream.at, GITLAB_EVERY_MS, clock.now(), force);
    });
  }
  // A GraphQL area whose throttle hold outlasts what this sweep may still wait is deferred
  // rather than read, so the sweep ends inside its interval and says why it skipped.
  function throttledReason(): { code: "throttled"; reason: string; resumeAt: string } | undefined {
    const held = account.throttled();
    return held && {
      code: "throttled", reason: `GitHub throttled GraphQL until ${held.until} (${held.reason})`, resumeAt: held.until,
    };
  }
  function area<K extends AreaName>(
    name: K, core: boolean, estimate: number, interval: number,
    read: (input: Input, gh: Gh, glab: Glab) => Promise<{
      data: NonNullable<Facts[K]["data"]>; reads: readonly ReadRecord[];
      code?: SweepReasonCode;
      reason?: string;
    }>,
  ) {
    // The discriminated union is preserved at the table boundary.
    const entry = {
      name,
      shouldRead: (input: Input): SweepReadDecision => {
        const { cache, facts, force, clock } = input;
        if (name === "upstream" && facts.upstream.data && !upstreamForks(input).length)
          return { state: "skipped", code: "cadence", reason: "not due" };
        if (name !== "upstream" && interval && facts[name].data && !(name === "radar" && upstreamChanged) &&
          !due(facts[name].at, interval, clock.now(), force))
          return { state: "skipped", code: "cadence", reason: "not due" };
        const throttled = estimate > 0 && throttledReason();
        if (throttled) {
          cache.budget.deferred.push({ area: name, reason: throttled.reason });
          return { state: "throttled", ...throttled };
        }
        const before = account.snapshot();
        const decision = pacer.plan({
          ...(before.remaining === null ? {} : { remaining: before.remaining }),
          ...(before.resetAt === null ? {} : { resetAt: before.resetAt }),
          history: cache.history, areas: [{ area: name, core, estimate }], now: clock.now().getTime(),
        })[0];
        // Below the floor every GitHub read waits; auth must run so sign-in is known, and upstream
        // reads only GitLab. With the budget unknown the pacer still runs core areas.
        if (name !== "auth" && name !== "upstream" && decision?.kind !== "run") {
          const reason = decision?.reason ?? "budget unknown";
          cache.budget.deferred.push({ area: name, reason });
          return {
            state: "deferred", code: "budget", reason,
            ...(decision?.kind === "wait-until-reset" ? { resumeAt: decision.until } : {}),
          };
        }
        return true;
      },
      read: async (input: Input) => {
        const { cache } = input;
        readingSource = name;
        notify = input.progress;
        const before = account.snapshot();
        try {
          const result = await read(input, new Gh(input.exec, undefined, account), new Glab(input.exec));
          if (name !== "auth" && result.reads.length && result.reads.every((r) => r.failure)) {
            const failure = result.reads[0]?.failure;
            if (name === "upstream" && glabNeedsReadiness)
              throw new ForgeError(failure ?? "GitLab upstream reads failed", null, "signin");
            const throttled = throttledReason();
            if (failure && throttled) throw new ForgeError(failure, null, "throttle", throttled.resumeAt);
            throw new Error(failure);
          }
          return result;
        } finally {
          readingSource = undefined;
          notify = undefined;
          const cost = account.snapshot().spent - before.spent;
          cache.history = [...cache.history.filter((h) => h.area !== name), { area: name, cost }];
        }
      },
    };
    areas.push(entry as SweepArea<CollectorCache>);
  }
  area("auth", true, 0, 0, async ({ clock }, gh, glab) => {
    let signinTool: "gh" | "glab" | undefined;
    const data = {
      gh: await gh.status(() => { signinTool = "gh"; }),
      glab: await glab.status(() => { signinTool ??= "glab"; glabNeedsReadiness = true; }),
    };
    return { data, code: signinTool ? "signin" : "other",
      ...(signinTool ? { reason: data[signinTool].detail } : {}),
      reads: Object.entries(data).map(([source, result]) => ({
      source, object: "auth", observedAt: clock.now().toISOString(), completeness: { kind: "complete" as const },
      ...(!result.ok ? { failure: result.detail } : {}),
    })) };
  });
  area("fleet", true, 1, 0, async ({ facts, reads, clock }, gh) => {
    const { reads: records, ...data } = await readFleet(gh,
      facts.fleet.data ? { ...facts.fleet.data, reads: reads.fleet } : undefined,
      clock.now(), options.fleetFiles, options.ctx.stackRepo, options.ctx.voice);
    view = fleetView({ ...data, reads: records }, options.fleetFiles ?? {}, {
      now: clock.now(), readFile: options.readFile, previous: view, voice: options.ctx.voice,
    });
    return { data, reads: view.reads };
  });
  area("github", true, 10, 0, async ({ ctx, facts, reads }, gh) => {
    const result = await readGithub(gh, ctx, parseGithub);
    const retained = retain(result.facts.repos, facts.github.data?.repos, result.records,
      reads.github ?? [], (r) => r.object);
    return { data: { ...result.facts, repos: retained.data }, reads: retained.reads };
  });
  area("runs", true, 0, 0, async (input, gh) => {
    const { ctx, facts, reads, cache } = input;
    const result = await readForkRuns(gh, ctx);
    const retained = retain(result.data, facts.runs.data, result.reads, reads.runs ?? [], (r) => r.source);
    for (const [repo, entry] of Object.entries(retained.data)) {
      if (retained.reads.some((r) => r.source === repo && r.failure)) continue;
      const readJobs = async (run: typeof entry.main[number]) => {
        const key = jobsKey(run);
        const known = cache.lifecycle.runJobs[key];
        if (known && settledJobReads(known.reads)) {
          result.reads.push(...known.reads);
          return known.data;
        }
        const jobs = await readRunJobs(gh, cache.details, repo, run, ctx, known);
        cache.details = jobs.cache;
        result.reads.push(...jobs.reads);
        if (jobs.data) cache.lifecycle.runJobs[key] = { data: jobs.data, reads: jobs.reads };
        return jobs.data;
      };
      entry.mainRunJobs = {};
      for (const run of entry.main.filter((r) => r.status === "completed").slice(0, 5)) {
        const jobs = await readJobs(run);
        if (!jobs) break;
        entry.mainRunJobs[run.id] = jobs;
        if (javaBuilt(jobs)) break;
      }
      const cascade = entry.cascade[0];
      if (cascade?.status === "completed" && cascade.conclusion === "failure") {
        const jobs = await readJobs(cascade);
        if (jobs) entry.cascadeRunJobs = { [cascade.id]: jobs };
        const object = `repos/${repo}/commits/fork_integration`;
        const record = { source: repo, object, observedAt: ctx.clock.now().toISOString(),
          completeness: { kind: "complete" as const } };
        try {
          entry.integration = await gh.rest<{ sha: string; at: string }>(
            object, "{sha: .sha, at: .commit.committer.date}");
          result.reads.push(record);
        } catch (error) {
          result.reads.push({ ...record, failure: errorText(error) });
        }
      }
    }
    return { data: retained.data, reads: [...retained.reads, ...result.reads.slice(retained.reads.length)] };
  });
  area("approvals", true, 0, 0, async ({ ctx, facts, reads, cache }, gh) => {
    const result = await readApprovals(gh, ctx, cache.approvals);
    cache.approvals = result.cache;
    return retain(result.data, facts.approvals.data, result.reads, reads.approvals ?? [], (r) => r.source);
  });
  area("lifecycle", true, 0, 0, async ({ ctx, cache }, gh) => {
    const result = await readLifecycle(gh, cache.details, cache.lifecycle, ctx);
    cache.lifecycle = result.state;
    cache.details = result.cache;
    return result;
  });
  area("template", true, 0, 0, async ({ ctx, facts, reads, cache }, gh) => {
    const result = await readTemplate(ctx, gh, facts.github.data?.repos ?? {}, cache.template,
      facts.template.data ? { ...facts.template.data, reads: [...(reads.template ?? [])], state: cache.template } : undefined);
    cache.template = result.state;
    const { state: _state, reads: records, ...data } = result;
    return { data, reads: records };
  });
  area("details", false, 1, 0, async ({ ctx, facts, cache, reads: previousReads }, gh) => {
    const data: Record<string, JobDetail> = {};
    const reads: ReadRecord[] = [];
    for (const repo of ctx.fleet.repos) for (const pr of facts.github.data?.repos[repo]?.prs ?? []) {
      for (const check of failedChecks(pr)) {
        if (!check.workflow || check.name === "Validation Summary") continue;
        const result = await readJob(gh, cache.details, repo, check.id, check.name, ctx);
        cache.details = result.cache;
        const key = `${repo}#${check.id}`;
        if (result.data) {
          data[key] = result.data;
          reads.push(...result.reads);
        } else {
          const retained = retain({}, facts.details.data, result.reads,
            previousReads.details ?? [], () => key);
          Object.assign(data, retained.data);
          reads.push(...retained.reads);
        }
      }
    }
    return { data, reads };
  });
  area("upstream", true, 0, GITLAB_EVERY_MS, async (input, _gh, glab) => {
    const { ctx, facts, cache, reads } = input;
    const forks = upstreamForks(input);
    const sources = new Set(forks.map((fork) => fork.upstream));
    const result = await readUpstream(glab, facts.github.data?.repos ?? {}, cache.upstream,
      { ...ctx, fleet: { ...ctx.fleet, forks } });
    const idOf = (r: ReadRecord) => ctx.fleet.forks.find((f) => f.upstream === r.source)?.id ?? "";
    const failures = new Map(result.reads.filter((r) => r.failure).map((r) => [r.source, r.failure]));
    const records = result.reads.map((r) =>
      !result.upstream[idOf(r)] && failures.has(r.source)
        ? { ...r, failure: r.failure ?? `Upstream frame incomplete: ${failures.get(r.source)}` } : r);
    const retained = retain(result.upstream, facts.upstream.data, records, reads.upstream ?? [], idOf);
    // Carry other forks' last reads, but only for forks still in the fleet.
    const ids = new Set(ctx.fleet.forks.map((fork) => fork.id));
    const live = new Set(ctx.fleet.forks.map((fork) => fork.upstream));
    const data = Object.fromEntries(Object.entries({ ...facts.upstream.data, ...retained.data })
      .filter(([id]) => ids.has(id)));
    upstreamChanged = !isDeepStrictEqual(data, facts.upstream.data);
    return { data, reads: [
      ...(reads.upstream ?? []).filter((r) => !sources.has(r.source) && live.has(r.source)),
      ...retained.reads,
    ] };
  });
  area("radar", false, 5, GITLAB_EVERY_MS, async ({ ctx, facts, reads, cache }, gh, glab) => {
    const result = await readRadar(gh, glab, facts.upstream.data ?? {}, cache.radar, ctx,
      reads.upstream, facts.radar.data);
    const lists = result.reads.filter((r) => r.object === "merge_requests?state=opened&target_branch=master");
    if (lists.length && lists.every((r) => r.failure))
      throw new ForgeError(lists[0]?.failure ?? "GitLab merge request lists failed", null,
        glabNeedsReadiness ? "signin" : undefined);
    const { reads: records, ...data } = result;
    return { data, reads: records };
  });
  area("security", false, 0, SECURITY_EVERY_MS, async ({ ctx, facts, reads }, gh) =>
    readSecurity(gh, facts.security.data ? {
      data: facts.security.data, reads: reads.security ?? [], at: facts.security.at,
    } : undefined, ctx));

  return new Sweeper({
    ...options, areas, cacheSchema, emptyCache, inflight: collectorInflight,
    prune: (facts, cache) => pruneCache(facts, cache, options.ctx),
    context: (facts) => {
      if (!facts.fleet.data?.forks && !options.fleetFiles?.services && !facts.fleet.data?.rollout)
        return options.ctx;
      view = fleetView(facts.fleet.data, options.fleetFiles ?? {}, {
        now: options.ctx.clock.now(), readFile: options.readFile, previous: view, voice: options.ctx.voice,
      });
      return createContext({ ...options.ctx,
        fleet: facts.fleet.data?.forks || options.fleetFiles?.services
          ? fleetOf(view.fleet.services, options.ctx.stackRepo, options.ctx.fleet.coreLib)
          : options.ctx.fleet,
        rollout: view.rollout.rollout ?? options.ctx.rollout });
    },
    beforeSweep: ({ cache }) => {
      baseline = account.snapshot();
      account.allowThrottleWait(THROTTLE_WAIT_ALLOWANCE_MS);
      upstreamChanged = false;
      glabNeedsReadiness = false;
      cache.budget.deferred = [];
    },
    afterAreas: async ({ ctx, exec, facts, cache, force, clock, progress }) => {
      // Deferred entries belong to this sweep, including collectors without a Facts area.
      const throttled = due(cache.releases.at, RELEASES_EVERY_MS, clock.now(), force) && throttledReason();
      if (throttled) {
        cache.budget.deferred.push({ area: "releases", reason: throttled.reason });
        progress?.({
          kind: "source", source: "releases", state: "throttled",
          endedAt: clock.now().toISOString(), ...throttled,
        });
      }
      else if (due(cache.releases.at, RELEASES_EVERY_MS, clock.now(), force)) {
        const snapshot = account.snapshot();
        const decision = pacer.plan({
          ...(snapshot.remaining === null ? {} : { remaining: snapshot.remaining }),
          ...(snapshot.resetAt === null ? {} : { resetAt: snapshot.resetAt }),
          history: cache.history, areas: [{ area: "releases", core: false, estimate: 5 }],
          now: clock.now().getTime(),
        })[0];
        if (decision?.kind === "run") {
          const reader = new ReleaseReader(new Gh(exec, undefined, account), {
            load: async () => cache.releases,
            save: async (state) => { cache.releases = state; },
          }, ctx);
          progress?.({
            kind: "source", source: "releases", state: "reading", startedAt: clock.now().toISOString(),
          });
          readingSource = "releases";
          notify = progress;
          try {
            await reader.read({ force, ...(facts.github.data ? { openPrs: facts.github.data.repos } : {}) });
          } catch (error) {
            progress?.(sweepFailureProgress("releases", error, reader.records, clock.now().toISOString()));
            throw error;
          } finally {
            readingSource = undefined;
            notify = undefined;
          }
          if (progress) {
            const held = throttledReason();
            const outcome = sweepReadProgress(
              "releases", reader.records, clock.now().toISOString(), held?.code, undefined, ctx.fleet,
            );
            progress({
              ...outcome,
              ...(outcome.state === "failed" && held ? { state: "throttled", code: "throttled", resumeAt: held.resumeAt } : {}),
            });
          }
          cache.history = [...cache.history.filter((h) => h.area !== "releases"),
            { area: "releases", cost: account.snapshot().spent - snapshot.spent }];
        } else {
          const reason = decision?.reason ?? "budget unknown";
          cache.budget.deferred.push({ area: "releases", reason });
          progress?.({
            kind: "source", source: "releases", state: "deferred",
            endedAt: clock.now().toISOString(), code: "budget", reason,
            ...(decision?.kind === "wait-until-reset" ? { resumeAt: decision.until } : {}),
          });
        }
      } else {
        progress?.({
          kind: "source", source: "releases", state: "skipped",
          endedAt: clock.now().toISOString(), code: "cadence", reason: "not due",
        });
      }
      const snapshot = account.snapshot();
      cache.budget = {
        cost: snapshot.spent - baseline.spent, calls: snapshot.calls - baseline.calls,
        remaining: snapshot.remaining, resetAt: snapshot.resetAt, deferred: cache.budget.deferred,
      };
    },
  });
}
