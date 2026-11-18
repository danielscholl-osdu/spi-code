// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { ViewSnapshotSchema } from "@spi-code/contracts";
import { describe, expect, test } from "vitest";
import { watchFixtures } from "../../../scripts/watch-generated.mjs";
import { todayLines } from "../src/brief/lines";
import { releasesToday } from "../src/brief/releases-today";
import { serviceHome } from "../src/brief/service-home";
import { sinceOf } from "../src/brief/since";
import { todayHistory, todaySummary } from "../src/brief/today-summary";
import type { PrFact, RepoAlerts } from "../src/facts";
import { workflowEvidence } from "../src/inspect/item-evidence";
import { groupUrl } from "../src/inspect/repo";
import {
  sweep1116Context as context,
  SWEEP_1116_NOW as now,
  sweep1116Facts,
  sweep1116Items,
  sweep1116Model,
} from "./sweep-1116";

const facts = sweep1116Facts();
const model = sweep1116Model(facts);
const items = sweep1116Items(model);
const lines = todayLines(model, items, now, context);
const since = sinceOf(model, facts, now, 300_000);
const summary = () => todaySummary({ model, facts, items, lines, since, now, context });
const objectsIn = (row: ReturnType<typeof summary>["causes"]["rows"][number]) =>
  row.forks.flatMap(({ objects }) => objects);

test("Release and Dependabot reconcile by PR URL on every complete fork in the watch mornings", () => {
  const recorded = new URL(
    "../../../apps/window/src/views/today/snapshot-1116.json",
    import.meta.url,
  );
  const fixtures = [
    ...watchFixtures().filter(({ name }) => name.startsWith("snapshot-")),
    { name: "16 Nov", path: recorded },
  ];
  for (const { name, path } of fixtures) {
    const { briefing, services } = ViewSnapshotSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    const causes = name === "16 Nov" ? summary().causes : briefing.today?.causes;
    if (!causes || !services) throw new Error(`${name} has no causes or services`);
    const sources = new Map<string, "blocked" | "waiting">();
    const evidence = new Map(
      [...briefing.focus, ...briefing.rest].map((item) => [item.id, item.evidence]),
    );
    for (const section of ["waiting", "blocked"] as const) {
      for (const line of briefing.lines ?? []) {
        if (line.section !== section) continue;
        for (const member of line.members) {
          const urls = [
            member.subject,
            member.primary?.url,
            ...member.ids.flatMap((id) => (evidence.get(id) ?? []).map(({ url }) => url)),
          ];
          for (const url of urls) if (url) sources.set(url, section);
        }
      }
    }
    for (const kind of ["release", "dependabot"] as const) {
      const cause = causes.rows.find((row) => row.kind === kind);
      const chips = cause?.forks.filter(({ group, notRead }) => group === "fork" && !notRead) ?? [];
      const held = { blocked: 0, waiting: 0 };
      let counted = 0;
      for (const { service, home } of services) {
        const door = home?.doors.find(({ id }) => id === kind);
        if (!door || door.count === null) continue;
        const remaining =
          chips.find(({ fork }) => fork === service)?.objects.map(({ url }) => url) ?? [];
        const inYours = door.prs.filter(({ url }) => sources.has(url));
        for (const { url } of inYours) {
          const section = sources.get(url);
          if (section) held[section]++;
        }
        const partition = [...remaining, ...inYours.map(({ url }) => url)];
        const at = `${name} ${service} ${kind}`;
        expect(partition.sort(), at).toEqual(door.prs.map(({ url }) => url).sort());
        expect(new Set(partition).size, at).toBe(door.count);
        counted += remaining.length;
      }
      expect(cause?.forkCount ?? 0, name).toBe(chips.length);
      expect(cause?.count ?? 0, name).toBe(counted);
      expect(cause?.remainder ?? { blocked: 0, waiting: 0 }, name).toEqual(held);
    }
  }
});

test("classifies a second release and a labeled station PR, and exposes pulls held by a failed read", () => {
  const input = sweep1116Facts();
  const repo = "Azure/osdu-spi-search";
  const github = input.github.data?.repos[repo];
  if (!github || !input.github.data) throw new Error("Missing recorded search repository");
  const pull = (number: number, head: string, base = "main", labels: string[] = []): PrFact => ({
    repo,
    number,
    head,
    base,
    labels,
    url: `https://github.com/${repo}/pull/${number}`,
    title: `PR ${number}`,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    draft: false,
    headSha: "abc",
    checks: [],
  });
  const [release, second, station, dependabot] = [
    pull(501, "release-please--branches--main"),
    pull(502, "release-please--second"),
    pull(503, "sync/upstream-new", "fork_upstream", ["autorelease: pending"]),
    pull(504, "dependabot/maven/sample"),
  ] as const;
  github.prs = [release, second, station, dependabot];
  github.openPrs = 4;
  const unknown = {
    ...release,
    repo: "Elsewhere/search",
    url: "https://github.com/Elsewhere/search/pull/501",
  };
  input.github.data.repos[unknown.repo] = {
    ...github,
    repo: unknown.repo,
    prs: [unknown],
    openPrs: 1,
  };
  const model = sweep1116Model(input);
  const seed = lines[0];
  const member = seed?.members[0];
  if (!seed || !member) throw new Error("16 Nov has a Today member");
  const held = (pr: PrFact, section: "blocked" | "waiting") => ({
    ...seed,
    id: `${section}:${pr.number}`,
    section,
    members: [{ ...member, id: pr.url, ids: [], subject: pr.url }],
  });
  const complete = todaySummary({
    model,
    facts: input,
    items: [],
    lines: [held(release, "waiting"), held(dependabot, "blocked")],
    since,
    now,
    context,
  });
  expect(complete.causes.rows.find(({ kind }) => kind === "release")?.remainder).toEqual({
    blocked: 0,
    waiting: 1,
  });
  expect(complete.causes.rows.find(({ kind }) => kind === "dependabot")?.remainder).toEqual({
    blocked: 1,
    waiting: 0,
  });
  const reads = {
    github: [
      {
        source: "github",
        object: repo,
        observedAt: now.toISOString(),
        completeness: { kind: "complete" } as const,
        failure: "GitHub unavailable",
      },
    ],
  };
  const projected = todaySummary({
    model,
    facts: input,
    items: [],
    lines: [],
    since,
    now,
    context,
    reads,
  });
  const home = serviceHome({
    model,
    facts: input,
    items: [],
    lines: [],
    canWait: projected.canWait,
    versions: [],
    now,
    reads,
  }).get("search");
  const leaves = (kind: string) => projected.causes.rows.filter((row) => row.kind === kind);
  for (const [kind, pr] of [
    ["release", release],
    ["dependabot", dependabot],
  ] as const) {
    expect(home?.doors.find(({ id }) => id === kind)).toMatchObject({
      count: null,
      prs: [{ url: pr.url }],
    });
    expect(projected.causes.notRead[kind].join(", ")).toContain("search");
    const [row] = leaves(kind);
    expect(row?.forks).toContainEqual(
      expect.objectContaining({
        fork: "search",
        group: "fork",
        notRead: true,
        objects: [expect.objectContaining({ url: pr.url })],
      }),
    );
    expect(row?.count).toBe(
      row?.forks
        .filter(({ group, notRead }) => group === "fork" && !notRead)
        .reduce((n, { count }) => n + count, 0),
    );
  }
  expect(leaves("release")[0]?.forks).toContainEqual(
    expect.objectContaining({
      group: "unknown",
      objects: [expect.objectContaining({ url: unknown.url })],
    }),
  );
  expect(
    leaves("other")
      .flatMap(objectsIn)
      .map(({ url }) => url),
  ).toContain(second.url);
  expect(projected.causes.rows.flatMap(objectsIn).map(({ url }) => url)).not.toContain(station.url);
});

describe("Today's lower sections on the unchanged 16 Nov sweep", () => {
  test("one pile per place with the release, repository and security counts", () => {
    const piles = summary().canWait;
    const release = releasesToday({ services: [], documents: [], facts, provenance: [], context });
    expect(release.readyLine).toBe(
      "14 release PRs open: osdu-spi-stack #474 ready to merge, 13 wait for review, none failing",
    );
    expect(release.ready).toEqual([
      {
        name: "osdu-spi-stack",
        number: 474,
        url: "https://github.com/Azure/osdu-spi-stack/pull/474",
      },
    ]);
    expect(piles.map((p) => [p.label, p.place])).toEqual([
      ["Release PRs", "releases"],
      ["Repositories", "engineering"],
      ["Security", "security"],
    ]);
    expect(piles.map((p) => p.counts.map((c) => [c.kind, c.count]))).toEqual([
      [
        ["open", 14],
        ["ready", 1],
        ["review", 13],
        ["failed", 0],
      ],
      [
        ["issues", 8],
        ["changes", 7],
        ["dependabot", 27],
      ],
      [
        ["vulnerabilities", 6],
        ["code-scanning", 22],
      ],
    ]);
    const issues = Object.values(facts.github.data?.repos ?? {}).flatMap((r) => r.issues);
    const human = piles[1]?.counts.find((c) => c.kind === "issues")?.urls ?? [];
    expect(human.map((url) => issues.find((i) => i.url === url)?.title)).toEqual(
      Array(8).fill(expect.stringContaining("CODEOWNERS")),
    );
    expect(piles[0]?.counts.find((c) => c.kind === "ready")?.names).toEqual([
      "osdu-spi-stack #474",
    ]);
  });

  test.each(["all repositories", "one repository"])(
    "Can wait names GitHub not read for %s",
    (scope) => {
      const unread = sweep1116Facts();
      const missing = model.repositories.rows.filter(
        (r) => scope === "all repositories" || r.name === "indexer",
      );
      expect(missing.length).toBeGreaterThan(0);
      if (scope === "all repositories") unread.github = {};
      else for (const r of missing) delete unread.github.data?.repos[r.repo];
      const unreadModel = sweep1116Model(unread);
      const unreadItems = sweep1116Items(unreadModel);
      const { canWait: piles, causes } = todaySummary({
        model: unreadModel,
        facts: unread,
        items: unreadItems,
        lines: todayLines(unreadModel, unreadItems, now, context),
        since,
        now,
        context,
      });
      expect(piles.find((p) => p.id === "repositories")?.notRead).toEqual(
        missing.map((r) => `${r.name}: issues and PRs`),
      );
      expect(piles.find((p) => p.id === "releases")?.notRead).toEqual(
        missing.map((r) => `${r.name}: release PRs`),
      );
      expect(causes.notRead).toMatchObject({
        release: piles[0]?.notRead,
        other: missing.filter(({ group }) => group === "fork").map(({ name }) => name),
        issue: piles[1]?.notRead,
        dependabot: missing.filter(({ group }) => group === "fork").map(({ name }) => name),
        alert: piles[2]?.notRead,
      });
    },
  );

  test("no member or source of a Today line is in Can wait; exclusion uses the supplied lines", () => {
    const urls = new Set(
      lines.flatMap((l) =>
        l.members.flatMap((m) => [
          m.subject,
          m.primary?.url,
          ...items.filter((i) => m.ids.includes(i.id)).flatMap((i) => i.evidence.map((e) => e.url)),
        ]),
      ),
    );
    expect(
      summary()
        .canWait.flatMap((p) => p.counts.flatMap((c) => c.urls))
        .some((u) => urls.has(u)),
    ).toBe(false);
    const withoutLines = todaySummary({ model, facts, items, lines: [], since, now, context });
    expect(withoutLines.canWait[1]?.counts.find((c) => c.kind === "issues")?.count).toBe(15);
  });

  test("cause object IDs reconcile with Can wait and add only shipped upstream alerts", () => {
    const { canWait, causes } = summary();
    const byKind = (kind: string) =>
      causes.rows.filter((row) => row.kind === kind).flatMap(objectsIn);
    for (const [kind, pile, count] of [
      ["release", "releases", "open"],
      ["dependabot", "repositories", "dependabot"],
      ["other", "repositories", "changes"],
      ["issue", "repositories", "issues"],
    ] as const) {
      const urls = canWait
        .find(({ id }) => id === pile)
        ?.counts.find(({ kind }) => kind === count)?.urls;
      expect(
        byKind(kind)
          .map(({ id }) => id)
          .sort(),
      ).toEqual([...(urls ?? [])].sort());
    }
    const alertCounts = canWait.find(({ id }) => id === "security")?.counts ?? [];
    const upstream = model.repositories.rows.flatMap((repo) =>
      repo.alerts
        .filter(
          (alert) =>
            alert.owner === "upstream" &&
            alert.reach === "shipped" &&
            (alert.counts.high ?? 0) + (alert.counts.critical ?? 0) > 0,
        )
        .map((alert) => ({
          url: groupUrl(repo, alert),
          count: (alert.counts.high ?? 0) + (alert.counts.critical ?? 0),
        })),
    );
    expect(upstream.length).toBeGreaterThan(0);
    expect(
      byKind("alert")
        .map(({ url }) => url)
        .sort(),
    ).toEqual(
      [...alertCounts.flatMap(({ urls }) => urls), ...upstream.map(({ url }) => url)].sort(),
    );
    expect(byKind("alert").reduce((sum, { count }) => sum + count, 0)).toBe(
      [...alertCounts, ...upstream].reduce((sum, { count }) => sum + count, 0),
    );
    const ids = causes.rows.flatMap(objectsIn).map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("groups normalized titles and shared packages without losing objects on the same fork", () => {
    const input = sweep1116Facts();
    const repos = input.github.data?.repos;
    if (!repos) throw new Error("Recorded repository facts are missing");
    for (const repo of Object.values(repos))
      Object.assign(repo, { prs: [], issues: [], openPrs: 0, openIssues: 0 });
    const security: Record<string, RepoAlerts> = {};
    input.security.data = security;
    const ids: string[] = [];
    const forks = model.lines.map(({ fork }) => fork);
    const earlier = "2026-11-15T01:00:00Z";
    const later = "2026-11-16T01:00:00Z";
    forks.slice(0, 8).forEach(({ repo, id }, index) => {
      const found = repos[repo];
      if (!found) throw new Error(`Missing ${id}`);
      const pull = (number: number, title: string, head = "human/work", createdAt = later) => {
        const url = `https://github.com/${repo}/pull/${number}`;
        ids.push(url);
        found.prs.push({
          repo,
          number,
          title,
          head,
          url,
          createdAt,
          updatedAt: later,
          base: "main",
          draft: false,
          headSha: "abc",
          labels: [],
          checks: [],
        });
      };
      if (index < 7)
        pull(1, index % 2 ? "  chore:   Rotate\tcertificates  " : "Chore: rotate certificates");
      if (index < 4)
        pull(2, `Bump library from 1 to ${index + 2}`, `dependabot/maven/library-${index + 2}`);
      if (index === 0) {
        pull(3, "chore: audit manifests", "human/audit", earlier);
        pull(4, "chore: clean tests");
        pull(5, " chore: rotate CERTIFICATES ");
        pull(6, "release 2.0.0", "release-please--branches--main", earlier);
        pull(7, "Bump library from 1 to 4", "dependabot/npm/library-4");
      }
      const issue = `https://github.com/${repo}/issues/8`;
      ids.push(issue);
      found.issues.push({
        repo,
        number: 8,
        url: issue,
        title: index % 2 ? " Review   settings" : "review settings",
        labels: ["human-required"],
        createdAt: earlier,
        updatedAt: later,
        comments: 0,
      });
      found.openPrs = found.prs.length;
      found.openIssues = found.issues.length;
      const alert = (number: number, rule: string, description: string) => ({
        number,
        rule,
        description,
        severity: "high" as const,
        tool: "CodeQL",
        createdAt: earlier,
        path: "src/main/java/Sample.java",
        url: `https://github.com/${repo}/security/code-scanning/${number}`,
      });
      security[repo] = {
        dependabot: [],
        code: [
          ...(index < 3 ? [alert(1, "b", "B rule"), alert(2, "c", "C rule")] : []),
          ...(index === 0 ? Array.from({ length: 5 }, (_, i) => alert(i + 3, "a", "A rule")) : []),
        ],
      };
    });
    const program = repos["Azure/osdu-spi-stack"];
    const sample = repos[forks[0]?.repo ?? ""]?.prs[0];
    if (!program || !sample) throw new Error("Recorded program and fork PR facts are missing");
    const programPr = `https://github.com/${program.repo}/pull/1`;
    program.prs = [{ ...sample, repo: program.repo, url: programPr }];
    program.openPrs = 1;
    ids.push(programPr);
    const built = sweep1116Model(input);
    const { causes } = todaySummary({
      model: built,
      facts: input,
      items: [],
      lines: [],
      since,
      now,
      context,
    });
    const { rows } = causes;
    expect(rows.map(({ kind, count, forkCount }) => [kind, count, forkCount])).toEqual([
      ["release", 1, 1],
      ["dependabot", 5, 4],
      ["issue", 8, 8],
      ["other", 8, 7],
      ["other", 1, 1],
      ["other", 1, 1],
      ["alert", 11, 3],
    ]);
    expect(rows[0]).toMatchObject({ place: "releases", forks: [{ objects: [{ age: "2d" }] }] });
    const first = forks[0]?.id;
    expect(rows[1]?.packages).toEqual([
      { ecosystem: "maven", name: "library", forks: forks.slice(0, 4).map(({ id }) => id) },
    ]);
    expect(
      rows[3]?.forks.find(({ fork }) => fork === first)?.objects.map(({ label }) => label),
    ).toEqual(["PR #1", "PR #5"]);
    expect(rows[3]?.forks).toContainEqual(
      expect.objectContaining({
        fork: "osdu-spi-stack",
        group: "program",
        objects: [expect.objectContaining({ url: programPr })],
      }),
    );
    expect(rows.slice(4, 6)).toMatchObject([
      { headline: "chore: audit manifests", forks: [{ fork: first }] },
      { headline: "chore: clean tests", forks: [{ fork: first }] },
    ]);
    expect(rows.at(-1)).toMatchObject({
      place: "security",
      rules: { mostAlerts: { name: "A rule", count: 5 }, mostForks: { name: "B rule", count: 3 } },
    });
    expect(
      rows
        .filter(({ kind }) => kind !== "alert")
        .flatMap(objectsIn)
        .map(({ id }) => id)
        .sort(),
    ).toEqual(ids.sort());
  });

  test("at most three moving or scheduled rows, with lanes counted from stations", () => {
    const moving = summary().moving;
    expect(moving.length).toBeGreaterThan(0);
    expect(moving.length).toBeLessThanOrEqual(3);
    expect(moving.find((r) => r.id === "lanes")?.names).toEqual(["partition"]);
    expect(moving.every((r) => r.time && r.place)).toBe(true);
    const crowded = structuredClone(model);
    crowded.stack.inflight = { run: { kind: "upgrade" } } as typeof crowded.stack.inflight;
    expect(
      todaySummary({ model: crowded, facts, items, lines, since, now, context }).moving,
    ).toHaveLength(3);
  });

  test("one history row per workflow with failed and not-read outcomes counted apart", () => {
    const history = summary().history;
    expect(history.basis).toBe("fallback");
    expect(history.rows.map((r) => r.workflow)).toEqual(["sync", "template"]);
    expect(history.rows[0]?.counts.find((c) => c.kind === "failed")?.names).toEqual([
      "indexer",
      "search",
      "crs-conversion",
    ]);
    expect(history.rows[0]?.counts.find((c) => c.kind === "not-read")?.count).toBeGreaterThan(0);
    for (const row of history.rows)
      expect(row.counts.reduce((n, c) => n + c.count, 0)).toBe(model.lines.length);
  });

  test("a workflow whose runs were not read never claims zero failures", () => {
    const unread = sweep1116Facts();
    unread.runs = {};
    const unreadModel = sweep1116Model(unread);
    for (const workflow of ["sync", "template"] as const) {
      const evidence = workflowEvidence(
        unreadModel,
        unread,
        "indexer",
        workflow,
        since?.from ?? new Date(now.getTime() - 86_400_000).toISOString(),
        now.toISOString(),
      );
      expect(evidence.runsRead).toBe(false);
      expect(evidence.notRead).toContain(
        `${workflow === "sync" ? "Sync Upstream" : "Sync Template"} runs on indexer`,
      );
    }
    const history = todayHistory(unreadModel, unread, since, now);
    for (const row of history.rows) {
      expect(row.counts).toEqual([expect.objectContaining({ kind: "not-read", count: 13 })]);
      expect(row.notRead).toHaveLength(13);
    }
  });

  test("seen history keeps its window and names outcomes that were not read", () => {
    const seen = sinceOf(model, facts, now, 300_000, "2026-11-16T20:00:00Z");
    const history = todayHistory(model, facts, seen, now);
    expect(history.basis).toBe("seen");
    expect(history.from).toBe("2026-11-16T20:00:00.000Z");
    expect(history.rows[0]?.counts.some((c) => c.kind === "not-read")).toBe(true);
  });
});
