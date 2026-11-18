// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { lastRun } from "../src/brief/environment";
import { type BriefFact, buildBriefing, type DoctorView, readItem } from "../src/brief/index";
import { ago, deployableWords, streakText } from "../src/brief/words";
import { createContext, defaultContext } from "../src/context";
import { type DeploymentFact, emptyFacts, type Facts, type LifecycleRun } from "../src/facts";
import { buildModel, type Model } from "../src/model/index";
import { buildQueue, type QueueItem } from "../src/model/queue";
import { toCrons } from "../src/model/schedule";
import { fixtureContext } from "./briefing-setup";
import { settled } from "./flow-states";
import { FIXTURE_NOW, fixtureFacts } from "./harness";

const CLEAR: DoctorView = { state: "clear", problems: [] };

function fixtureModel(): Model {
  return buildModel(fixtureFacts(), FIXTURE_NOW, {}, fixtureContext);
}

function item(over: Partial<QueueItem>): QueueItem {
  return {
    id: "x",
    kind: "gate1",
    rung: 1,
    scope: "svc",
    text: "",
    effects: [],
    cause: [],
    incident: false,
    blocks: 1,
    ...over,
  };
}

// The fixture with its queue replaced and every line read as current.
function withQueue(items: QueueItem[]): Model {
  const m = fixtureModel();
  m.queue.items = items;
  m.queue.counts = {
    p0: items.filter((i) => i.rung === 0).length,
    p1: items.filter((i) => i.rung === 1).length,
    p2: items.filter((i) => i.rung === 2).length,
  };
  for (const l of m.lines) l.pill = { label: "current", kind: "current", tone: "ok" };
  m.stoppedForks = [];
  return m;
}

const RELEASES = item({
  id: "releases",
  kind: "releases",
  rung: 2,
  scope: "fleet",
  text: "2 release PRs · partition v1.3.2, legal v1.2.1 · review required",
  effects: [{ text: "partition #175" }, { text: "legal #36" }],
});

describe("the recorded sweep", () => {
  const b = buildBriefing(fixtureModel(), CLEAR, FIXTURE_NOW, fixtureContext);

  test("the headline names two causes as imperatives and counts the rest", () => {
    expect(b.headline).toBe("Restore the environment. Unhalt entitlements. 2 more causes below.");
  });

  test("the summary leaves the environment to the headline that already names it", () => {
    expect(b.summary).toBe("2 forks have been stopped for 4 days. 1 PR is ready for review.");
  });

  test("the template fact's figure is a count, never a status word", () => {
    expect(b.repositories.template).toEqual({
      label: "Template · main bb49a03",
      figure: "0 of 5",
      sub: "on main · 4 changes reach the forks · 5 of 5 on v1.2.0",
      tone: "warn",
    });
  });

  test("the template fact names forks not read and shows ? when none was read", () => {
    const m = fixtureModel();
    for (const row of m.template.rows) row.label = undefined;
    m.template.read = 0;
    m.template.current = 0;
    m.template.onRelease = 0;
    expect(
      buildBriefing(m, CLEAR, FIXTURE_NOW, fixtureContext).repositories.template,
    ).toMatchObject({
      figure: "?",
      sub: "on main · 5 not read yet · 4 changes reach the forks · 0 of 5 on v1.2.0",
    });
  });

  test("the template sync-PR row counts adoption over every fork and names forks not read", () => {
    const m = fixtureModel();
    const tag = m.template.latestTag;
    for (const row of m.template.rows) row.target = tag;
    const rollout = (model: Model) =>
      buildBriefing(model, CLEAR, FIXTURE_NOW, fixtureContext).themes.find(
        (t) => t.kind === "rollout",
      );
    expect(rollout(m)?.sub).toBe("5 sync PRs, review required · 5 of 5 adopted");

    for (const row of m.template.rows.slice(0, 2)) row.label = undefined;
    m.template.read = 3;
    m.template.onRelease = 3;
    expect(rollout(m)?.sub).toBe("5 sync PRs, review required · 3 of 5 adopted · 2 not read yet");

    for (const row of m.template.rows) row.label = undefined;
    m.template.read = 0;
    m.template.onRelease = 0;
    expect(rollout(m)?.sub).toBe("5 sync PRs, review required · 0 of 5 adopted · 5 not read yet");
  });

  test("focus puts incidents first and folds owed ports into one row", () => {
    expect(b.focus.map((f) => f.id)).toEqual([
      "stack:38181620856",
      "halt:entitlements",
      "rollout",
      "gate1:legal",
      "approvals:Azure/osdu-spi-stack",
    ]);
    const port = b.rest[0];
    if (!port) throw new Error("fixture has port");
    expect(port.ids).toEqual(["port:entitlements", "port:legal"]);
    expect(port.title).toBe("3 upstream provider changes not ported");
    expect(port.sub).toBe("entitlements 2 · legal 1");
  });

  test("every focus id is a queue item the inspector can open", () => {
    const ids = new Set(fixtureModel().queue.items.map((i) => i.id));
    for (const f of b.focus) for (const id of f.ids) expect(ids.has(id)).toBe(true);
  });

  test("a halt says what it is, what it holds and how far the entry reaches", () => {
    const halt = b.focus[1];
    if (!halt) throw new Error("fixture has halt");
    expect(halt.title).toBe("Sync halted on schemathesis-tests");
    expect(halt.sub).toContain("the same entry is missing from 4 other filters");
    expect(halt.cause).toBe(
      "Upstream adds schemathesis-tests, a top-level entry the fork's filter has no rule for, so Sync Upstream stops with UNKNOWN_TOP_LEVEL.",
    );
    expect(halt.verb).toBe("Classify entry");
    expect(halt.next).toMatch(/\.$/);
  });

  test("themes group one cause across forks, certain apart from possible", () => {
    expect(b.themes.map((t) => t.id)).toEqual([
      "toolchain:Java 25",
      "toolchain:os-core-common 9.2.0",
      "toolchain:os-core-common 8.2.0",
      "halt:top_level:schemathesis-tests",
      "port",
      "deadline:azure-removal",
    ]);
    const java = b.themes[0];
    if (!java) throw new Error("fixture has java");
    expect(java.certain.map((f) => f.fork)).toEqual(["legal"]);
    expect(java.possible.map((f) => f.fork).sort()).toEqual(["partition", "schema"]);
    const halt = b.themes.find((theme) => theme.kind === "halt");
    if (!halt) throw new Error("fixture has halt");
    expect(halt.sub).toBe(
      "halted: entitlements · 4 other filters lack it · open MRs bring it to legal and file",
    );
    expect(halt.exposed).not.toContain("legal");
  });

  test("the horizon headline counts the stages, and the halt theme the filters it would fix", () => {
    expect(b.horizon.headline).toBe("Nothing lands at the next sync; 6 commits won't land.");
    const halt = b.themes.find((theme) => theme.kind === "halt");
    expect((halt?.exposed.length ?? 0) + (halt?.possible.length ?? 0)).toBe(4);
  });

  test("each theme says its next step in one sentence", () => {
    expect(
      Object.fromEntries(
        b.themes.filter((t) => !t.title.startsWith("os-core-common")).map((t) => [t.kind, t.next]),
      ),
    ).toEqual({
      toolchain: "Move one fork's Java pin to 25 and repeat it for the others.",
      halt: "Add a rule for schemathesis-tests to every fork's .github/upstream-filter.yml, starting with entitlements.",
      port: "Port each MR into its fork-owned tree and cite the MR URL in the PR body.",
      deadline:
        "Upstream removes the Azure provider code at the deadline; forks keep their own copy.",
    });
  });

  test("a theme opens the queue item that carries its verbs, and only a real one", () => {
    expect(b.themes.map((t) => t.inspect)).toEqual([
      "gate1:legal",
      "gate1:legal",
      undefined,
      "halt:entitlements",
      "port:entitlements",
      undefined,
    ]);
    const ids = new Set(fixtureModel().queue.items.map((i) => i.id));
    for (const t of b.themes) if (t.inspect) expect(ids.has(t.inspect)).toBe(true);
  });

  test("ready work is never ranked into focus", () => {
    expect(b.focus.some((f) => f.rung === 2)).toBe(false);
  });
});

describe("other days", () => {
  test("a quiet day says nothing needs you and when the next sync runs", () => {
    const b = buildBriefing(withQueue([]), CLEAR, FIXTURE_NOW, fixtureContext);
    expect(b.headline).toBe("Nothing needs you. Next sync at 00:00.");
    expect(b.focus).toEqual([]);
  });

  test("a day with only ready work says nothing is broken", () => {
    const b = buildBriefing(withQueue([RELEASES]), CLEAR, FIXTURE_NOW, fixtureContext);
    expect(b.headline).toBe("Nothing is broken. 2 PRs are ready for review.");
    expect(b.summary).not.toContain("ready for review");
  });

  test("a toolchain incident joins the fork that the next sync will break the same way", () => {
    const m = withQueue([
      item({
        id: "gate1:legal",
        scope: "legal",
        cls: "TOOLCHAIN",
        incident: true,
        text: "sync PR #31 fails Java Build: upstream requires Java 25, the fork builds on 17",
        cause: [{ label: "reason", value: "JDK 17.0.20-1 is outside the allowed range [25,)" }],
      }),
      item({
        id: "radar:partition",
        kind: "radar",
        scope: "partition",
        cls: "TOOLCHAIN",
        text: "next sync carries Java 25 · 2 commits queued",
        cause: [{ label: "value", value: "Java 25" }],
      }),
    ]);
    const b = buildBriefing(m, CLEAR, FIXTURE_NOW, fixtureContext);
    expect(b.headline).toBe("Move legal to Java 25 before partition follows at 00:00.");
    expect(b.focus[1]?.sub).toBe(
      `2 commits queued · syncs at ${b.nextSyncAt} · expected to fail the way legal's did`,
    );
    expect(b.focus[1]?.effect).toBe(
      "2 commits reach the fork at the 00:00 sync. Legal's sync PR failed on the same move.",
    );
  });

  test("a toolchain incident gives no sync time for a follower its open sync PR holds", () => {
    const followed = (holds: number) => {
      const m = withQueue([
        item({
          id: "gate1:legal",
          scope: "legal",
          cls: "TOOLCHAIN",
          incident: true,
          text: "sync PR #31 fails Java Build: upstream requires Java 25, the fork builds on 17",
        }),
        item({
          id: "radar:partition",
          kind: "radar",
          scope: "partition",
          cls: "TOOLCHAIN",
          text: "sync PR #9 carries Java 25 · 2 commits in sync PR #9",
          cause: [{ label: "value", value: "Java 25" }],
        }),
      ]);
      const fork = m.upstream.forks.find((f) => f.service === "partition");
      if (!fork) throw new Error("fixture has partition");
      fork.behind = 2;
      fork.syncPr = { number: 9, url: "", headSha: "", verdict: "green", holds };
      return buildBriefing(m, CLEAR, FIXTURE_NOW, fixtureContext).headline;
    };
    expect(followed(2)).toBe("Move legal to Java 25 before partition follows.");
    expect(followed(1)).toBe("Move legal to Java 25 before partition follows at 00:00.");
  });

  test("an item carries its age and a blocks chip only when open work provably waits on it", () => {
    const hour = 60 * 60 * 1000;
    const since = new Date(FIXTURE_NOW.getTime() - 2 * hour).toISOString();
    const m = withQueue([
      item({
        id: "gate2:a",
        rung: 0,
        scope: "a",
        incident: true,
        since,
        effects: [{ text: "partition #175" }, { text: "legal #36" }],
      }),
      item({
        id: "gate1:b",
        scope: "b",
        since,
        cause: [{ label: "held", value: "1 upstream commit wait on this PR" }],
      }),
      item({ id: "gate1:c", scope: "c" }),
      item({
        id: "radar:d",
        kind: "radar",
        scope: "d",
        text: "next sync carries Java 25 · 2 commits queued",
        effects: [{ text: "!12" }],
      }),
    ]);
    const b = buildBriefing(m, CLEAR, FIXTURE_NOW, fixtureContext);
    const of = (id: string) => [...b.focus, ...b.rest].find((i) => i.id === id);
    expect(of("gate2:a")?.age).toBe("2h");
    expect(of("gate2:a")?.blocks).toBeUndefined();
    expect(of("gate1:b")?.blocks).toBeUndefined();
    expect(of("gate1:c")?.age).toBeUndefined();
    expect(of("gate1:c")?.blocks).toBeUndefined();
    expect(of("gate1:c")?.effect).toBe("Nothing else waits on it.");
    expect(of("radar:d")?.blocks).toBeUndefined();
  });

  test("the stack's blocks chip counts the PRs failing on it now, never its past attempts", () => {
    const facts = fixtureFacts();
    const stackOf = (m: Model) => m.queue.items.find((q) => q.kind === "stack");
    const chipOf = (m: Model) => {
      const id = stackOf(m)?.id;
      const b = buildBriefing(m, CLEAR, FIXTURE_NOW, fixtureContext);
      return [...b.focus, ...b.rest].find((i) => i.id === id)?.blocks;
    };
    const rebuilt = (m: Model): Model => {
      m.queue = buildQueue(
        {
          stack: m.stack,
          lines: m.lines,
          template: m.template,
          rollout: m.rollout,
          repos: facts.github.data?.repos ?? {},
          details: facts.details.data ?? {},
          approvals: facts.approvals.data,
          radar: m.radar,
          forks: m.upstream.forks,
          repositories: m.repositories,
          now: FIXTURE_NOW,
        },
        fixtureContext,
      );
      return m;
    };

    const mixed = fixtureModel();
    const stack = stackOf(mixed);
    const past = stack?.effects.filter((e) => !e.url?.includes("/job/")) ?? [];
    expect(past.length).toBeGreaterThan(0);
    expect(stack?.effects.length).toBeGreaterThan(stack?.blocks ?? 0);
    expect(stack?.blocks).toBe(5);
    expect(chipOf(mixed)).toEqual({ count: 5, text: "blocks 5" });

    const quiet = fixtureModel();
    for (const line of quiet.lines) {
      for (const pr of line.prs) pr.failures = pr.failures.filter((f) => f.cls !== "ENV");
    }
    const alone = stackOf(rebuilt(quiet));
    expect(alone?.effects.length).toBe(past.length);
    expect(alone?.blocks).toBe(0);
    expect(chipOf(quiet)).toBeUndefined();
  });

  test("a halt keeps the sync time for a will-halt follower its open sync PR holds", () => {
    const halt = { fork: "a", code: "UNKNOWN_TOP_LEVEL", entries: ["x"] };
    const m = withQueue([
      item({ id: "halt:a", kind: "halt", rung: 0, scope: "a", incident: true, halt }),
      item({
        id: "radar:partition",
        kind: "radar",
        scope: "partition",
        cls: "HALT",
        text: "next sync will halt on x (UNKNOWN_TOP_LEVEL) · 2 commits in sync PR #9",
        halt: { ...halt, fork: "partition" },
      }),
    ]);
    const fork = m.upstream.forks.find((f) => f.service === "partition");
    if (!fork) throw new Error("fixture has partition");
    fork.behind = 2;
    fork.syncPr = { number: 9, url: "", headSha: "", verdict: "green", holds: 2 };
    const b = buildBriefing(m, CLEAR, FIXTURE_NOW, fixtureContext);
    expect(b.headline).toBe("Unhalt a before partition halts at 00:00.");
    const radar = [...b.focus, ...b.rest].find((i) => i.id === "radar:partition");
    expect(radar?.sub).toBe("2 commits queued · syncs at 2026-10-13T00:00:00.000Z");
    expect(radar?.effect).toBe("2 commits reach the fork at the 00:00 sync.");
  });

  test("a queued break with no incident still leads the headline", () => {
    const m = withQueue([
      item({
        id: "radar:partition",
        kind: "radar",
        scope: "partition",
        cls: "TOOLCHAIN",
        text: "next sync carries Java 25 · 2 commits queued",
        cause: [{ label: "value", value: "Java 25" }],
      }),
    ]);
    expect(buildBriefing(m, CLEAR, FIXTURE_NOW, fixtureContext).headline).toBe(
      "Move partition to Java 25 before the 00:00 sync.",
    );
  });

  test("a halt with many followers names the first and counts the rest", () => {
    const followers = ["b", "c", "d", "e", "f", "g"].map((scope) =>
      item({
        id: `radar:${scope}`,
        kind: "radar",
        scope,
        cls: "HALT",
        halt: { fork: scope, code: "UNKNOWN_TOP_LEVEL", entries: ["x"] },
      }),
    );
    const halt = item({
      id: "halt:a",
      kind: "halt",
      rung: 0,
      scope: "a",
      incident: true,
      halt: { fork: "a", code: "UNKNOWN_TOP_LEVEL", entries: ["x"] },
    });
    const b = buildBriefing(withQueue([halt, ...followers]), CLEAR, FIXTURE_NOW, fixtureContext);
    expect(b.headline).toBe("Unhalt a before b and 5 more halt at 00:00.");
  });

  test("a halt on many entries names the first in the headline and the title", () => {
    const entries = ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9"];
    const radar = item({
      id: "radar:partition",
      kind: "radar",
      scope: "partition",
      cls: "HALT",
      halt: { fork: "partition", code: "UNKNOWN_TOP_LEVEL", entries },
    });
    const b = buildBriefing(withQueue([radar]), CLEAR, FIXTURE_NOW, fixtureContext);
    expect(b.headline).toBe("Classify e1 and 8 more on partition before the 00:00 sync.");
    expect(b.focus[0]?.title).toBe("Next sync halts on e1 and 8 more");
    expect(b.focus[0]?.sub).toContain("entries e1, e2, e3, e4, e5, e6, e7, e8 and e9");
  });

  test("a cause too long to share the headline leads it alone", () => {
    const radar = (scope: string) =>
      item({
        id: `radar:${scope}`,
        kind: "radar",
        scope,
        cls: "HALT",
        halt: { fork: scope, code: "UNKNOWN_TOP_LEVEL", entries: [`${scope}-entry`] },
      });
    const b = buildBriefing(
      withQueue([radar("partition"), radar("legal"), radar("storage")]),
      CLEAR,
      FIXTURE_NOW,
      fixtureContext,
    );
    expect(b.headline).toBe(
      "Classify partition-entry on partition before the 00:00 sync. 2 more causes below.",
    );
  });

  test("six incidents name two causes and count the rest", () => {
    const m = withQueue([
      item({ id: "stack:1", kind: "stack", rung: 0, scope: "Environment", incident: true }),
      item({ id: "lanes", kind: "lanes", rung: 0, scope: "fleet", incident: true }),
      item({ id: "halt:a", kind: "halt", rung: 0, scope: "a", incident: true }),
      item({ id: "main:b", kind: "main", rung: 0, scope: "b", incident: true }),
      item({ id: "conflict:c", kind: "conflict", rung: 0, scope: "c", incident: true }),
      item({ id: "gate1:d", scope: "d", cls: "BUILD", incident: true }),
    ]);
    const b = buildBriefing(m, CLEAR, FIXTURE_NOW, fixtureContext);
    expect(b.headline).toBe("Restore the environment. Unhalt a. 3 more causes below.");
    expect(b.focus).toHaveLength(5);
    expect(b.rest).toHaveLength(1);
    const ids = [...b.focus, ...b.rest].map((f) => f.id);
    expect(new Set(ids).size).toBe(6);
    expect(ids.sort()).toEqual(m.queue.items.map((i) => i.id).sort());
  });

  test("a dark GitHub leads with the source and its last read", () => {
    const dark: DoctorView = { state: "dark", problems: ["⚠ GitHub unread since 11:20"] };
    const b = buildBriefing(fixtureModel(), dark, FIXTURE_NOW, fixtureContext);
    expect(b.headline).toBe("GitHub unread since 11:20. Figures are from the last good read.");
  });

  test("a partial read opens the summary with the source that failed", () => {
    const partial: DoctorView = { state: "partial", problems: ["⚠ GitLab unread since 09:10"] };
    const b = buildBriefing(fixtureModel(), partial, FIXTURE_NOW, fixtureContext);
    expect(b.summary.startsWith("GitLab unread since 09:10.")).toBe(true);
  });

  test("before the first sweep there is nothing to brief", () => {
    const m = fixtureModel();
    m.measured = false;
    const b = buildBriefing(m, { state: "waiting", problems: [] }, FIXTURE_NOW, fixtureContext);
    expect(b.headline).toBe("The first sweep has not finished.");
    expect(b.repositories.template).toBeUndefined();
    expect(b.environment).toMatchObject({ facts: [], deployable: "unknown" });
  });
});

describe("the horizon", () => {
  const RADAR_PARTITION = item({
    id: "radar:partition",
    kind: "radar",
    scope: "partition",
    cls: "TOOLCHAIN",
    text: "next sync carries Java 25 · 2 commits queued",
    cause: [{ label: "value", value: "Java 25" }],
  });

  test("a sweep with no upstream theme still counts the commits its stages hold", () => {
    const m = withQueue([]);
    m.radar.services = {};
    const b = buildBriefing(m, CLEAR, FIXTURE_NOW, fixtureContext);
    expect(b.horizon.headline).toBe("Nothing lands at the next sync; 6 commits won't land.");
    expect(b.themes.every((t) => t.kind === "deadline")).toBe(true);
  });

  test("with no incident to open, a theme falls back to the radar item that carries it", () => {
    const radarHalt = item({
      id: "radar:legal",
      kind: "radar",
      scope: "legal",
      cls: "HALT",
      halt: { fork: "legal", code: "UNKNOWN_TOP_LEVEL", entries: ["schemathesis-tests"] },
    });
    const b = buildBriefing(withQueue([radarHalt]), CLEAR, FIXTURE_NOW, fixtureContext);
    expect(b.themes.find((t) => t.kind === "halt")?.inspect).toBe("radar:legal");
    expect(b.themes.find((t) => t.kind === "toolchain")?.inspect).toBeUndefined();
    expect(b.themes.find((t) => t.kind === "port")?.inspect).toBeUndefined();
  });

  test("a queued Java move leads the themes with every queued fork and the sync time", () => {
    const m = withQueue([RADAR_PARTITION]);
    const svc = m.radar.services.partition;
    if (!svc) throw new Error("fixture has svc");
    const java = m.radar.services.legal?.certain.find((v) => v.bucket === "Toolchain");
    if (!java) throw new Error("fixture has Java toolchain");
    svc.certain = [...svc.certain, java];
    svc.possible = svc.possible.filter((v) => v.bucket !== "Toolchain");
    const b = buildBriefing(m, CLEAR, FIXTURE_NOW, fixtureContext);
    expect(b.themes[0]?.title).toBe("Java 25");
    expect(b.themes[0]?.certain.map((f) => `${f.fork} ${f.state}`)).toEqual([
      "partition queued · syncs at 00:00",
      "legal queued · syncs at 00:00",
    ]);
    expect(b.themes.find((t) => t.kind === "halt")?.exposed.length).toBeGreaterThan(0);
    expect(b.themes[0]?.inspect).toBe("radar:partition");
  });

  test("a Java move queued on many forks keeps every fork on its theme", () => {
    const m = withQueue([RADAR_PARTITION]);
    const legal = m.radar.services.legal;
    const java = legal?.certain.find((v) => v.bucket === "Toolchain");
    if (!legal || !java) throw new Error("the fixture queues Java 25 on legal");
    for (const extra of ["storage", "search", "indexer", "workflow"])
      m.radar.services[extra] = structuredClone(legal);
    for (const svc of Object.values(m.radar.services)) {
      if (!svc) continue;
      svc.certain = [...svc.certain.filter((v) => v.bucket !== "Toolchain"), java];
      svc.possible = svc.possible.filter((v) => v.bucket !== "Toolchain");
    }
    const b = buildBriefing(m, CLEAR, FIXTURE_NOW, fixtureContext);
    expect(b.themes[0]?.certain.map((f) => f.fork).sort()).toEqual(
      Object.keys(m.radar.services).sort(),
    );
  });
});

describe("the environment", () => {
  const FIGURE = /^(v\d+\.\d+\.\d+|\d+%|\d+\u00a0(min|h|d)( \d+\u00a0(min|h))?|\?)$/;
  const IN_FLIGHT = 38312331838;
  const WINDOW_FROM = FIXTURE_NOW.getTime() - 86_400_000;

  // The app's words; the rib's default context keeps the boards' words byte for byte.
  const appWords = createContext({ ...fixtureContext, words: "app" });

  function envOf(facts: Facts, context = fixtureContext) {
    const m = buildModel(facts, FIXTURE_NOW, {}, context);
    const briefing = buildBriefing(m, CLEAR, FIXTURE_NOW, context);
    return { m, env: briefing.environment };
  }

  // The recorded in-flight upgrade, finished green at 21:58 with maintenance cleared.
  function finished(): Facts {
    const facts = fixtureFacts();
    const run = facts.lifecycle.data?.upgrade?.find((r) => r.id === IN_FLIGHT);
    if (!run) throw new Error("fixture lost its in-flight upgrade");
    Object.assign(run, { status: "completed", conclusion: "success" });
    for (const job of run.jobs ?? []) {
      Object.assign(job, { status: "completed", conclusion: "success" });
      job.completedAt ??= "2026-10-12T21:58:05Z";
      for (const step of job.steps) {
        Object.assign(step, { status: "completed", conclusion: "success" });
        step.startedAt ??= "2026-10-12T21:57:50Z";
        step.completedAt ??= "2026-10-12T21:58:00Z";
      }
    }
    return facts;
  }

  function figuresHold(facts: readonly BriefFact[]): void {
    expect(facts.map((f) => f.label)).toEqual(["Running", "Deployable · 21 days", "Last proof"]);
    for (const f of facts) expect(f.figure).toMatch(FIGURE);
  }

  test("the recorded sweep leads with the upgrade in flight and draws it open", () => {
    const { m, env } = envOf(fixtureFacts());
    expect(env.headline).toBe("An upgrade to v0.28.2 is running, at verify.");
    expect(env.lanes.map((l) => l.id)).toEqual(["upgrade", "refresh", "smoke", "holds"]);
    const upgrade = env.lanes[0]?.events ?? [];
    expect(upgrade.map((e) => [e.label, e.state])).toEqual([
      ["v0.28.1", "failed"],
      ["v0.28.1", "cancelled"],
      ["v0.28.2", "running"],
    ]);
    expect(upgrade[2]?.end).toBeUndefined();
    expect(upgrade[2]?.detail).toBe("running · at verify");
    expect(env.from).toBe(new Date(WINDOW_FROM).toISOString());
    expect(env.to).toBe(FIXTURE_NOW.toISOString());
    const holds = env.lanes[3]?.events ?? [];
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ state: "held", inspect: "stack:38181620856" });
    expect(holds[0]?.end).toBeUndefined();
    figuresHold(env.facts);
    expect(env.facts[0]?.sub).toBe("upgrade running · at verify · declares v0.28.2");
    expect(env.facts[0]?.tone).toBe("warn");
    expect(env.deployable).toBe("no");
    expect(env.facts[2]).toMatchObject({
      figure: "26\u00a0min",
      sub: "smoke · fresh cluster · 12\u00a0h 52\u00a0min ago · 7 in a row",
    });
    const queue = new Set(m.queue.items.map((i) => i.id));
    const inspected = env.lanes.flatMap((l) => l.events.flatMap((e) => e.inspect ?? []));
    expect(inspected.length).toBeGreaterThan(0);
    for (const id of inspected) expect(queue.has(id)).toBe(true);
  });

  test("SPI Code's default context keeps the environment headline and facts", () => {
    const { headline, facts } = buildBriefing(
      fixtureModel(),
      CLEAR,
      FIXTURE_NOW,
      defaultContext,
    ).environment;
    expect(headline).toBe("An upgrade to v0.28.2 is running, at verify.");
    expect(facts).toMatchInlineSnapshot(`
      [
        {
          "figure": "v0.28.0",
          "label": "Running",
          "sub": "upgrade running · at verify · declares v0.28.2",
          "tone": "warn",
        },
        {
          "figure": "63%",
          "label": "Deployable · 21 days",
          "sub": "6 holds over an hour, 7 d 14 h in all · held since 10-11 22:44",
          "tone": "warn",
        },
        {
          "figure": "26 min",
          "label": "Last proof",
          "sub": "smoke · fresh cluster · 12 h 52 min ago · 7 in a row",
          "tone": "ok",
        },
      ]
    `);
  });

  test("every event touches the window; a fresh-cluster smoke never shares a lane", () => {
    const { env } = envOf(fixtureFacts());
    for (const l of env.lanes) {
      for (const e of l.events) {
        expect(Date.parse(e.end ?? env.to)).toBeGreaterThanOrEqual(WINDOW_FROM);
        expect(Date.parse(e.start)).toBeLessThanOrEqual(FIXTURE_NOW.getTime());
      }
    }
    expect(env.lanes.find((l) => l.id === "smoke")?.events.map((e) => e.label)).toEqual(["smoke"]);
    expect(env.lanes.find((l) => l.id === "upgrade")?.events.some((e) => e.label === "smoke")).toBe(
      false,
    );
  });

  test("a hold no run is working on names the attempt that left it", () => {
    const facts = fixtureFacts();
    const lc = facts.lifecycle.data;
    if (lc?.upgrade) lc.upgrade = lc.upgrade.filter((r) => r.id !== IN_FLIGHT);
    const { env } = envOf(facts);
    expect(env.headline).toMatch(
      /^The environment is held: env-upgrade v0\.28\.1 cancelled at verify › .+\.$/,
    );
    expect(env.facts[0]?.sub).toMatch(/^held · env-upgrade v0\.28\.1 cancelled at verify/);
    expect(env.facts[0]?.tone).toBe("bad");
    expect(env.deployable).toBe("no");
    expect(env.facts[1]?.sub).toContain("held since");
    figuresHold(env.facts);
    const app = envOf(facts, appWords).env;
    expect(app.headline).toMatch(
      /^The environment is in maintenance: env-upgrade v0\.28\.1 cancelled at verify › .+\.$/,
    );
    expect(app.facts[0]?.sub).toMatch(
      /^in maintenance · env-upgrade v0\.28\.1 cancelled at verify/,
    );
    expect(app.facts[1]).toMatchObject({ label: "Ready · 21 days" });
    expect(app.facts[1]?.sub).toContain("in maintenance since");
    for (const text of [app.headline, ...app.facts.flatMap((f) => [f.label, f.sub])])
      expect(text).not.toMatch(/held|deployable/i);
  });

  test("a failed attempt after maintenance cleared says the environment is not ready", () => {
    const facts = finished();
    const upgrade = facts.lifecycle.data?.upgrade ?? [];
    const green = upgrade.find((r) => r.id === IN_FLIGHT);
    if (!green) throw new Error("fixture lost its in-flight upgrade");
    upgrade.push({
      ...green,
      id: 99_000_002,
      createdAt: "2026-10-12T22:30:00Z",
      updatedAt: "2026-10-12T22:40:00Z",
      conclusion: "failure",
      jobs: undefined,
    });
    const { env } = envOf(facts);
    expect(env.headline).toMatch(
      /^The environment is not deployable: env-upgrade v0\.28\.2 failed/,
    );
    expect(env.facts[0]?.sub).toMatch(/^not deployable · env-upgrade v0\.28\.2 failed/);
    expect(env.facts[0]?.tone).toBe("bad");
    expect(env.deployable).toBe("unknown");
    const app = envOf(facts, appWords).env;
    expect(app.headline).toMatch(/^The environment is not ready: env-upgrade v0\.28\.2 failed/);
    expect(app.facts[0]?.sub).toMatch(/^not ready · env-upgrade v0\.28\.2 failed/);
  });

  test("deployable after failures counts each failed attempt the timeline draws", () => {
    const { env } = envOf(finished());
    const failed = env.lanes
      .filter((l) => l.id === "upgrade" || l.id === "refresh")
      .flatMap((l) => l.events)
      .filter((e) => e.state === "failed");
    expect(failed).toHaveLength(2);
    expect(env.headline).toBe(
      "Deployable on v0.28.2 since 21:58, after 2 failed attempts in the last day.",
    );
    expect(env.facts[0]).toMatchObject({ figure: "v0.28.2", tone: "ok" });
    expect(env.facts[0]?.sub).toMatch(/^deployable · green at /);
    expect(env.deployable).toBe("yes");
    figuresHold(env.facts);
    const app = envOf(finished(), appWords).env;
    expect(app.headline).toBe(
      "Ready on v0.28.2 since 21:58, after 2 failed attempts in the last day.",
    );
    expect(app.facts[0]?.sub).toMatch(/^ready · green at /);
  });

  test("a day of green runs says so", () => {
    const facts = finished();
    const lc = facts.lifecycle.data;
    const keep = (r: LifecycleRun) =>
      r.conclusion === "success" || Date.parse(r.createdAt) < WINDOW_FROM;
    if (lc?.upgrade) lc.upgrade = lc.upgrade.filter(keep);
    if (lc?.refresh) lc.refresh = lc.refresh.filter(keep);
    const { env } = envOf(facts);
    expect(env.headline).toBe("Deployable on v0.28.2; every run in the last day was green.");
    expect(envOf(facts, appWords).env.headline).toBe(
      "Ready on v0.28.2; every run in the last day was green.",
    );
    const states = env.lanes.flatMap((l) => l.events.map((e) => e.state));
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((s) => s === "ok" || s === "held")).toBe(true);
    figuresHold(env.facts);
  });

  function withoutFailures(keepCancelled: boolean): Facts {
    const facts = finished();
    const lc = facts.lifecycle.data;
    const keep = (r: LifecycleRun) =>
      r.conclusion === "success" ||
      (keepCancelled && r.conclusion === "cancelled") ||
      Date.parse(r.createdAt) < WINDOW_FROM;
    if (lc?.upgrade) lc.upgrade = lc.upgrade.filter(keep);
    if (lc?.refresh) lc.refresh = lc.refresh.filter(keep);
    return facts;
  }

  test("a failed fresh-cluster smoke after a ready environment says so", () => {
    const facts = withoutFailures(false);
    const smoke = facts.lifecycle.data?.smoke ?? [];
    const last = smoke[0];
    if (!last) throw new Error("fixture lost its smoke run");
    smoke.unshift({
      ...last,
      id: 99_000_003,
      createdAt: "2026-10-12T19:00:00Z",
      updatedAt: "2026-10-12T19:20:00Z",
      conclusion: "failure",
      jobs: undefined,
    });
    expect(envOf(facts).env.headline).toMatch(
      /^Deployable on v0\.28\.2 since 21:58; smoke on a fresh cluster failed at 19:00\.$/,
    );
    expect(envOf(facts, appWords).env.headline).toMatch(
      /^Ready on v0\.28\.2 since 21:58; smoke on a fresh cluster failed at 19:00\.$/,
    );
  });

  test("cancelled runs after a ready environment are counted", () => {
    const facts = withoutFailures(true);
    expect(envOf(facts).env.headline).toBe(
      "Deployable on v0.28.2 since 21:58; 1 run cancelled in the last day.",
    );
    expect(envOf(facts, appWords).env.headline).toBe(
      "Ready on v0.28.2 since 21:58; 1 run cancelled in the last day.",
    );
  });

  test("a ready environment with no lifecycle run in the last day says so", () => {
    const facts = withoutFailures(false);
    const lc = facts.lifecycle.data;
    const before = (r: LifecycleRun) => Date.parse(r.createdAt) < WINDOW_FROM;
    if (lc) for (const kind of ["upgrade", "refresh"] as const) lc[kind] = lc[kind].filter(before);
    if (lc?.smoke) lc.smoke = lc.smoke.filter(before);
    expect(envOf(facts).env.headline).toBe(
      "Deployable on v0.28.0; no lifecycle run in the last day.",
    );
    expect(envOf(facts, appWords).env.headline).toBe(
      "Ready on v0.28.0; no lifecycle run in the last day.",
    );
  });

  test("with no lifecycle run read, the declaration stands in and the rest are unread", () => {
    const facts = fixtureFacts();
    facts.lifecycle.data = { refresh: [], upgrade: [], smoke: [], sweeper: [] };
    const { env } = envOf(facts);
    figuresHold(env.facts);
    expect(env.facts.map((f) => f.figure)).toEqual(["v0.28.2", "?", "?"]);
    expect(env.deployable).toBe("unknown");
    expect(env.lanes.every((l) => l.events.length === 0)).toBe(true);
    expect(env.headline).toBe("Deployability is unknown; no lifecycle run in the window says.");
    expect(env.facts[0]?.sub).toMatch(/^deployability unread/);
    const app = envOf(facts, appWords).env;
    expect(app.headline).toBe("Readiness is unknown; no lifecycle run in the window says.");
    expect(app.facts[0]?.sub).toMatch(/^readiness unread/);
    expect(app.facts[1]).toMatchObject({ label: "Ready · 21 days", sub: "no lifecycle run read" });
  });

  function failedAfterClear(): Facts {
    const facts = finished();
    const upgrade = facts.lifecycle.data?.upgrade ?? [];
    const green = upgrade.find((r) => r.id === IN_FLIGHT);
    if (!green) throw new Error("fixture lost its in-flight upgrade");
    upgrade.push({
      ...green,
      id: 99_000_002,
      createdAt: "2026-10-12T22:30:00Z",
      updatedAt: "2026-10-12T22:40:00Z",
      conclusion: "failure",
      jobs: undefined,
    });
    return facts;
  }

  function stackItemOf(facts: Facts, context = fixtureContext) {
    const m = buildModel(facts, FIXTURE_NOW, {}, context);
    const item = m.queue.items.find((i) => i.kind === "stack");
    if (!item) throw new Error("the made-up model must reach a stack item");
    const focus = buildBriefing(m, CLEAR, FIXTURE_NOW, context).focus.find((f) =>
      f.ids.includes(item.id),
    );
    if (!focus) throw new Error("the stack item must reach focus");
    return { item, focus };
  }

  const noStateWords = (texts: readonly string[]) => {
    for (const text of texts) expect(text).not.toMatch(/held|deployable/i);
  };

  test("a stack item after maintenance cleared says not ready in the app's words", () => {
    const boards = stackItemOf(failedAfterClear());
    expect(boards.item.text).toMatch(/^not deployable; last attempt env-upgrade v0\.28\.2 failed/);
    expect(boards.item.cause[0]?.value).toMatch(/^not deployable since /);
    expect(boards.focus.title).toBe("Not deployable");
    expect(boards.focus.cause).toMatch(/^Not deployable; last attempt /);
    const app = stackItemOf(failedAfterClear(), appWords);
    expect(app.item.text).toBe(boards.item.text.replace(/^not deployable/, "not ready"));
    expect(app.item.cause[0]?.value).toBe(
      boards.item.cause[0]?.value.replace(/^not deployable/, "not ready"),
    );
    expect(app.focus.title).toBe("Not ready");
    expect(app.focus.sub).toBe(boards.focus.sub);
    expect(app.focus.cause).toBe(boards.focus.cause.replace(/^Not deployable/, "Not ready"));
    noStateWords([
      app.focus.title,
      app.focus.sub,
      app.focus.cause,
      ...app.item.cause.map((c) => c.value),
    ]);
  });

  test("a held stack item keeps maintenance mode and never says held or deployable to the app", () => {
    const facts = () => {
      const f = fixtureFacts();
      const lc = f.lifecycle.data;
      if (lc?.upgrade) lc.upgrade = lc.upgrade.filter((r) => r.id !== IN_FLIGHT);
      return f;
    };
    const boards = stackItemOf(facts());
    const app = stackItemOf(facts(), appWords);
    expect(boards.item.text).toMatch(/^maintenance mode; last attempt env-upgrade v0\.28\.1 /);
    expect(app.item.text).toBe(boards.item.text);
    expect(app.focus.title).toBe("Maintenance mode");
    expect(app.item.cause[0]?.value).toBe(boards.item.cause[0]?.value);
    noStateWords([
      app.focus.title,
      app.focus.sub,
      app.focus.cause,
      ...app.item.cause.map((c) => c.value),
    ]);
  });

  test("the summary's environment sentence says in maintenance and ready in the app's words", () => {
    const summary = (deployable: Model["stack"]["deployable"], context = fixtureContext) => {
      const m = withQueue([]);
      delete m.stack.inflight;
      m.stack.deployable = deployable;
      return buildBriefing(m, CLEAR, FIXTURE_NOW, context).summary;
    };
    const held = { state: "no", reason: "The environment is in maintenance." } as const;
    expect(summary(held)).toBe("The environment is held: The environment is in maintenance.");
    expect(summary(held, appWords)).toBe("The environment is in maintenance.");
    const ready = {
      state: "yes",
      reason: "maintenance clear after the last lifecycle run",
    } as const;
    expect(summary(ready)).toBe("The environment is deployable again.");
    expect(summary(ready, appWords)).toBe("The environment is ready again.");
  });
});

describe("shared wording", () => {
  test("deployable is the share of the window not held, with its long holds and the hold now", () => {
    const d = deployableWords(fixtureModel(), FIXTURE_NOW);
    expect(d).toMatchObject({ label: "Deployable · 21 days", figure: "63%" });
    expect(d.sub).toMatch(
      /^6 holds over an hour, 7\u00a0d 14\u00a0h in all · held since 10-11 22:44$/,
    );
    const app = { timeStyle: "clock", words: "app" } as const;
    expect(deployableWords(fixtureModel(), FIXTURE_NOW, app)).toMatchObject({
      label: "Ready · 21 days",
      sub: expect.stringMatching(/ · in maintenance since 10-11 22:44$/),
    });
    const m = fixtureModel();
    const a = m.stack.availability;
    if (!a) throw new Error("fixture has an availability");
    const unknown = { ...m, stack: { ...m.stack, availability: { ...a, since: undefined } } };
    expect(deployableWords(unknown, FIXTURE_NOW).sub).toMatch(/ · held now$/);
    expect(deployableWords(unknown, FIXTURE_NOW, app).sub).toMatch(/ · in maintenance now$/);
  });

  test("an environment back up says since when; one with no lifecycle read has no figure", () => {
    const f = fixtureFacts();
    const lc = f.lifecycle.data;
    if (!lc) throw new Error("fixture has lifecycle runs");
    const cut = Date.parse("2026-10-11T22:00:00Z");
    f.lifecycle.data = {
      ...lc,
      refresh: lc.refresh.filter((r) => Date.parse(r.createdAt) < cut),
      upgrade: lc.upgrade.filter((r) => Date.parse(r.createdAt) < cut),
    };
    expect(
      deployableWords(buildModel(f, FIXTURE_NOW, {}, fixtureContext), FIXTURE_NOW).sub,
    ).toMatch(/ · up since 10-11 21:4\d$/);
    const none = fixtureFacts();
    none.lifecycle.data = { refresh: [], upgrade: [], smoke: [], sweeper: [] };
    expect(deployableWords(buildModel(none, FIXTURE_NOW, {}, fixtureContext), FIXTURE_NOW)).toEqual(
      {
        label: "Deployable · 21 days",
        figure: null,
        sub: "no lifecycle run read",
      },
    );
  });

  test("a streak reads from two runs, and ago reads a span", () => {
    const smoke = fixtureModel().stack.lifecycle.smoke;
    expect(streakText(smoke)).toBe("7 in a row");
    expect(streakText({ ...smoke, streak: { n: 1, green: true } })).toBeUndefined();
    expect(streakText({ ...smoke, streak: { n: 2, green: false } })).toBe("red 2 in a row");
    expect(ago("2026-10-12T20:58:30Z", FIXTURE_NOW)).toBe("1\u00a0h ago");
  });
});

describe("one item as the inspector reads it", () => {
  const model = fixtureModel();
  const read = (id: string) => {
    const found = model.queue.items.find((i) => i.id === id);
    if (!found) throw new Error(`fixture has no ${id}`);
    return readItem(model, found, FIXTURE_NOW, fixtureContext);
  };

  test("a gap shows only when the item names what the fork has and what upstream needs", () => {
    expect(read("gate1:legal").gap).toEqual({ have: "Java 17", need: "Java 25" });
    expect(read("halt:entitlements").gap).toBeUndefined();
    expect(
      readItem(
        model,
        item({ cls: "TOOLCHAIN", text: "requires Java 25" }),
        FIXTURE_NOW,
        fixtureContext,
      ).gap,
    ).toBeUndefined();
  });

  test("related rows are the same cause on other forks, each opening its own item", () => {
    expect(read("gate1:legal").related.map((r) => [r.text, r.inspect])).toEqual([
      ["partition", "mr:partition:830"],
      ["schema", "mr:schema:867"],
    ]);
    expect(read("port:legal").related.map((r) => [r.text, r.inspect])).toEqual([
      ["entitlements", "port:entitlements"],
    ]);
    expect(read("approvals:Azure/osdu-spi-stack").related).toEqual([]);
  });

  test("the title is the console's, and a port names its count rather than its trees", () => {
    const b = buildBriefing(model, CLEAR, FIXTURE_NOW, fixtureContext);
    const legal = b.focus.find((f) => f.id === "gate1:legal");
    expect(read("gate1:legal").title).toBe(legal?.title ?? "");
    expect(read("port:entitlements").title).toBe("2 upstream MRs not ported");
  });
});

describe("Environment borrow status in the app context", () => {
  const now = new Date("2026-03-10T12:00:00Z");
  const app = createContext({ words: "app", timeZone: "UTC" });
  const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();
  const deployment = (id: string, start: number, state: string, end?: number): DeploymentFact => ({
    id,
    createdAt: at(start),
    state,
    ...(end === undefined ? {} : { statusAt: at(end) }),
  });
  const history = (
    fork: string,
    deployments: DeploymentFact[],
    read: Model["forkDeployments"][number]["read"] = "complete",
  ) => ({ fork, read, deployments });
  function modelFor(forkDeployments: Model["forkDeployments"]): Model {
    const model = fixtureModel();
    const stack = model.stack;
    stack.lifecycle.refresh.runs = [];
    stack.lifecycle.upgrade.runs = [];
    stack.lifecycle.smoke.runs = [];
    return { ...model, forkDeployments };
  }
  const brief = (model: Model, context = app) =>
    buildBriefing(model, CLEAR, now, context).environment;

  test("joins touching measured borrows across forks into the live stretch", () => {
    const model = modelFor([
      history("search", [deployment("1", -80, "SUCCESS", -60)]),
      history("storage", [deployment("2", -60, "FAILURE", -45)]),
      history("indexer", [deployment("3", -45, "IN_PROGRESS")]),
      history("legal", [], "unread"),
    ]);
    expect(brief(model).status).toEqual({
      state: "in-use",
      label: "In use",
      length: "1\u00a0h 20\u00a0min",
      live: [{ fork: "indexer", id: "indexer:3" }],
    });
    model.forkDeployments[2] = history("indexer", [deployment("3", -45, "SUCCESS", -30)]);
    expect(brief(model).status).toMatchObject({ state: "unknown", reason: "legal not read" });
    model.forkDeployments[3] = history("legal", []);
    expect(brief(model).status).toMatchObject({
      state: "idle",
      length: "30\u00a0min",
      reason: "last: indexer, green 11:30",
    });
    model.forkDeployments.push(history("file", [deployment("4", -15, "FAILURE")]));
    expect(brief(model).status).toEqual({
      state: "idle",
      label: "Idle",
      reason: "last borrow unknown",
    });
  });

  test("maintenance takes precedence and suppresses the facts line", () => {
    const model = fixtureModel();
    model.forkDeployments = [
      history("indexer", [
        {
          id: "1",
          createdAt: new Date(FIXTURE_NOW.getTime() - 45 * 60_000).toISOString(),
          state: "IN_PROGRESS",
        },
      ]),
    ];
    const env = buildBriefing(model, CLEAR, FIXTURE_NOW, app).environment;
    expect(env.status).toMatchObject({
      state: "maintenance",
      label: "In maintenance",
      length: expect.any(String),
    });
    expect(env.line).toBeUndefined();
  });

  test.each([
    {
      states: [history("legal", []), history("file", [])],
      state: "idle",
      reason: "last borrow unknown",
    },
    {
      states: [history("legal", [], "unread"), history("file", [], "unread")],
      state: "unknown",
      reason: "legal, file not read",
    },
    {
      states: ["legal", "file", "search", "partition"].map((fork) => history(fork, [], "unread")),
      state: "unknown",
      reason: "4 forks not read",
    },
    {
      states: [
        history(
          "indexer",
          [
            deployment("2", -45, "SUCCESS", -30),
            deployment("1", -7 * 24 * 60, "SUCCESS", -6 * 24 * 60),
          ],
          "capped",
        ),
      ],
      state: "idle",
      reason: "last: indexer, green 11:30",
      length: "30\u00a0min",
    },
    {
      states: [history("indexer", [deployment("2", -45, "SUCCESS", -30)], "capped")],
      state: "unknown",
      reason: "indexer history incomplete",
    },
  ])("reports $state for $reason", ({ states, state, reason, length }) => {
    const env = brief(modelFor(states));
    expect(env.status).toMatchObject({ state, reason });
    expect(env.status?.length).toBe(length);
    expect(env.forksNote).toBe(state === "unknown" ? reason : undefined);
  });

  test("uses the last success when GitHub marks older deployments inactive seconds later", () => {
    const sweep = new Date("2026-11-06T14:02:00.133Z");
    const model = modelFor([
      history("entitlements", [
        {
          id: "3",
          createdAt: "2026-11-05T21:15:34Z",
          state: "SUCCESS",
          statusAt: "2026-11-05T21:21:38Z",
        },
        {
          id: "2",
          createdAt: "2026-11-05T19:55:19Z",
          state: "INACTIVE",
          statusAt: "2026-11-05T21:21:51Z",
        },
        {
          id: "1",
          createdAt: "2026-11-05T18:15:27Z",
          state: "INACTIVE",
          statusAt: "2026-11-05T21:21:44Z",
        },
      ]),
    ]);
    expect(buildBriefing(model, CLEAR, sweep, app).environment.status).toMatchObject({
      state: "idle",
      label: "Idle",
      length: "16\u00a0h 40\u00a0min",
      reason: "last: entitlements, green Thu 21:21",
    });
  });

  test("starts in Usage unknown before a read", () => {
    const model = buildModel(emptyFacts(), now, {}, app);
    expect(brief(model).status).toMatchObject({ state: "unknown" });
  });

  test("caps inactive estimates at the next deployment and leaves unmeasured ticks without an end", () => {
    const inactive = deployment("1", -40, "INACTIVE", -20);
    const measured = deployment("2", -30, "SUCCESS", -10);
    const model = modelFor([history("file", [inactive, measured])]);
    const borrow = () => brief(model).borrows?.find(({ id }) => id === "file:1");
    expect(borrow()).toMatchObject({
      end: measured.createdAt,
      estimated: true,
      result: "unknown",
      links: [],
    });
    model.forkDeployments = [history("file", [inactive])];
    expect(borrow()).toMatchObject({ start: inactive.createdAt, links: [] });
    expect(borrow()?.end).toBeUndefined();
    expect(borrow()?.estimated).toBeUndefined();
  });

  test("overlap is the union of measured intervals, naming distinct other forks", () => {
    const model = modelFor([
      history("search", [deployment("1", -50, "SUCCESS", -10)]),
      history("file", [deployment("2", -60, "SUCCESS", -35), deployment("3", -40, "FAILURE", -30)]),
      history("legal", [deployment("4", -35, "IN_PROGRESS")]),
      history("storage", [deployment("5", -25, "INACTIVE", -10)]),
      history("indexer", [deployment("6", -20, "SUCCESS", -15)]),
    ]);
    const overlap = () => brief(model).borrows?.find(({ id }) => id === "search:1")?.overlap;
    expect(overlap()).toBe("Overlapped file, legal, indexer for 40\u00a0min");
    model.forkDeployments.push(history("schema", [deployment("7", -20, "SUCCESS", -15)]));
    expect(overlap()).toBe("Overlapped 4 forks for 40\u00a0min");
  });

  test("keeps the smoke failure visible while the next smoke is running", () => {
    const model = modelFor([history("indexer", [])]);
    const smoke = {
      kind: "smoke",
      name: "Smoke",
      path: "smoke.yml",
      event: "schedule",
      sha: "",
      title: "",
      url: "",
      attempt: 1,
    } as const;
    model.stack.lifecycle.smoke.runs = [
      {
        ...smoke,
        id: 1,
        status: "completed",
        conclusion: "failure",
        createdAt: at(-30),
        updatedAt: at(-17),
      },
      { ...smoke, id: 2, status: "in_progress", createdAt: at(-9), updatedAt: at(-8) },
    ];
    expect(brief(model).line).toContain("smoke failed 11:43, rerunning");
  });

  test.each([
    ["America/Chicago", "2026-03-04T06:00:00.000Z"],
    ["Asia/Kathmandu", "2026-03-03T18:15:00.000Z"],
  ])("starts six local midnights back in %s", (timeZone, expected) => {
    const env = brief(modelFor([]), createContext({ ...app, timeZone }));
    expect(env.from).toBe(expected);
    expect(env.to).toBe(now.toISOString());
  });
});

describe("Stack lanes in the app context", () => {
  const now = new Date("2026-03-10T12:00:00Z");
  const app = createContext({ words: "app", timeZone: "America/Chicago" });
  const at = (hours: number) => new Date(now.getTime() + hours * 3_600_000).toISOString();
  let id = 0;
  const run = (
    kind: LifecycleRun["kind"],
    start: number,
    over: Partial<LifecycleRun> = {},
  ): LifecycleRun => ({
    id: ++id,
    name: kind,
    path: `${kind}.yml`,
    event: "schedule",
    status: "completed",
    conclusion: "success",
    createdAt: at(start),
    updatedAt: at(start + 0.5),
    sha: "abc",
    title: kind,
    url: "",
    attempt: 1,
    kind,
    ...over,
  });
  function modelWith(runs: Partial<Record<LifecycleRun["kind"], LifecycleRun[]>>): Model {
    const model = buildModel(fixtureFacts(), FIXTURE_NOW, {}, fixtureContext);
    const stack = model.stack;
    for (const kind of ["refresh", "reset", "upgrade", "smoke"] as const)
      stack.lifecycle[kind].runs = runs[kind] ?? [];
    stack.unread = [];
    stack.schedules = {
      refresh: toCrons(["0 4 * * 1-5"]),
      reset: [],
      upgrade: [],
      smoke: toCrons(["0 8 * * *"]),
      sweeper: [],
    };
    return model;
  }
  const lanes = (model: Model, context = app) =>
    buildBriefing(model, CLEAR, now, context).environment.lanes;
  const lane = (model: Model, kind: string, context = app) =>
    lanes(model, context).find((item) => item.id === kind);

  test("each lane says its cadence in the app's zone, and none while the workflows are unread", () => {
    const model = modelWith({});
    const cadences = (context: typeof app) =>
      lanes(model, context).map(({ id, cadence }) => [id, cadence]);
    expect(cadences(app)).toEqual([
      ["refresh", "Sun–Thu 23:00"],
      ["reset", "by hand, weekly"],
      ["upgrade", "on version bump"],
      ["smoke", "nightly 03:00"],
      ["holds", undefined],
    ]);
    expect(cadences(createContext({ ...app, timeZone: "Asia/Kathmandu" })).slice(0, 4)).toEqual([
      ["refresh", "Mon–Fri 09:45"],
      ["reset", "by hand, weekly"],
      ["upgrade", "on version bump"],
      ["smoke", "daily 13:45"],
    ]);
    model.stack.schedules = undefined;
    expect(lanes(model).every(({ cadence }) => cadence === undefined)).toBe(true);
  });

  test("an empty lane names its last run even when the day before it is empty", () => {
    const model = modelWith({ refresh: [run("refresh", -100), run("refresh", -74)] });
    expect(lane(model, "refresh")?.last).toEqual({ text: "Sat 7 Mar · green" });
    model.stack.lifecycle.refresh.runs.push(run("refresh", -3, { conclusion: "failure" }));
    expect(lane(model, "refresh")?.last).toBeUndefined();
    expect(lane(model, "smoke")?.last).toBeUndefined();
  });

  test.each([
    [7, { note: "7 days ago" }],
    [8, { note: "8 days ago", late: true }],
  ])("a reset %i days old reads its age, late only after seven", (days, expected) => {
    const model = modelWith({
      reset: [run("reset", -24 * days - 0.5, { event: "workflow_dispatch" })],
    });
    expect(lane(model, "reset")?.last).toEqual({ text: expect.any(String), ...expected });
  });

  test("Upgrade names a release not adopted at now, and a past day adds neither age nor version", () => {
    const model = modelWith({
      upgrade: [run("upgrade", -200, { target: "v0.35.5" })],
      reset: [run("reset", -200)],
    });
    model.stack.latest = "v0.35.6";
    model.stack.declared = "v0.35.5";
    expect(lane(model, "upgrade")?.last).toEqual({
      text: "v0.35.5 · Sun 1 Mar · green",
      note: "v0.35.6 not adopted",
    });
    const dayStart = now.getTime() - 3 * 86_400_000;
    for (const kind of ["upgrade", "reset"] as const)
      expect(lastRun(model, kind, dayStart, dayStart + 86_400_000, false, app)).not.toHaveProperty(
        "note",
      );
    model.stack.declared = "v0.35.6";
    expect(lane(model, "upgrade")?.last).not.toHaveProperty("note");
  });

  test("by hand marks dispatched Refresh and Smoke runs, never Reset", () => {
    const dispatched = { event: "workflow_dispatch" };
    const model = modelWith({
      refresh: [run("refresh", -5, dispatched)],
      reset: [run("reset", -4, dispatched)],
      smoke: [run("smoke", -3, dispatched), run("smoke", -2)],
    });
    const byHand = (kind: string) => lane(model, kind)?.events.map((event) => event.byHand);
    expect(byHand("refresh")).toEqual([true]);
    expect(byHand("reset")).toEqual([undefined]);
    expect(byHand("smoke")).toEqual([true, undefined]);
  });

  test("a nightly slot is missed only when no scheduled run answers it inside the late window", () => {
    // Slots fall at 08:00 UTC; now is 12:00, so today's slot is past its three-hour window.
    const model = modelWith({
      smoke: [
        run("smoke", -28 + 0.5),
        run("smoke", -52 + 0.2, { event: "workflow_dispatch" }),
        run("smoke", -76 + 4),
      ],
    });
    const missed = () => lane(model, "smoke")?.missed;
    expect(missed()).toEqual(
      ["2026-03-04", "2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08", "2026-03-10"].map(
        (day) => `${day}T08:00:00.000Z`,
      ),
    );
    model.stack.unread = ["smoke"];
    expect(missed()).toBeUndefined();
    model.stack.unread = [];
    model.stack.schedules = undefined;
    expect(missed()).toBeUndefined();
  });

  test("Reset is drawn between Refresh and Upgrade once read, and not at all while unread", () => {
    const model = modelWith({});
    expect(lanes(model).map(({ id }) => id)).toEqual([
      "refresh",
      "reset",
      "upgrade",
      "smoke",
      "holds",
    ]);
    expect(lane(model, "reset")?.events).toEqual([]);
    model.stack.unread = ["reset"];
    expect(lane(model, "reset")).toBeUndefined();
  });

  test("an interrupted reset holds the app in maintenance and leaves SPI Code's default context as it was", () => {
    const facts = settled(fixtureFacts());
    const plain = buildBriefing(
      buildModel(facts, FIXTURE_NOW, {}, defaultContext),
      CLEAR,
      FIXTURE_NOW,
      defaultContext,
    ).environment;
    const start = new Date(FIXTURE_NOW.getTime() - 60_000).toISOString();
    const step = (name: string, conclusion: string) => ({
      number: 1,
      name,
      status: "completed",
      conclusion,
      startedAt: start,
      completedAt: start,
    });
    const job = (
      jobId: number,
      name: string,
      steps: ReturnType<typeof step>[],
      conclusion: string,
    ) => ({
      id: jobId,
      name,
      status: "completed",
      conclusion,
      startedAt: start,
      completedAt: start,
      url: "",
      steps,
    });
    if (!facts.lifecycle.data) throw new Error("fixture has lifecycle runs");
    facts.lifecycle.data.reset = [
      {
        ...run("reset", 0, { event: "workflow_dispatch", conclusion: "cancelled" }),
        createdAt: start,
        updatedAt: start,
        jobs: [
          job(1, "quiesce-and-drain", [step("Set maintenance", "success")], "success"),
          job(2, "provision", [step("spi up", "cancelled")], "cancelled"),
        ],
      },
    ];
    const rib = buildBriefing(
      buildModel(facts, FIXTURE_NOW, {}, defaultContext),
      CLEAR,
      FIXTURE_NOW,
      defaultContext,
    ).environment;
    expect(rib.headline).toBe(plain.headline);
    expect(rib.headline).toMatch(/^Deployable on /);
    expect(rib.facts).toEqual(plain.facts);
    expect(rib.lanes.map(({ id }) => id)).toEqual(["upgrade", "refresh", "smoke", "holds"]);
    const model = buildModel(
      facts,
      FIXTURE_NOW,
      {},
      createContext({ ...app, clock: fixtureContext.clock }),
    );
    expect(model.stack.deployable.state).toBe("no");
    expect(model.stack.maintenance).toMatchObject({ state: "set", run: { kind: "reset" } });
    const env = buildBriefing(
      model,
      CLEAR,
      FIXTURE_NOW,
      createContext({ ...app, clock: fixtureContext.clock }),
    ).environment;
    expect(env.status).toMatchObject({
      state: "maintenance",
      reason: expect.stringMatching(/^Reset cancelled /),
    });
    const hold = env.lanes.find(({ id }) => id === "holds")?.events.at(-1);
    expect(hold?.start).toBe(start);
    expect(hold?.end).toBeUndefined();
  });
});
