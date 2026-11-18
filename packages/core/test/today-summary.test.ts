// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { todayLines } from "../src/brief/lines";
import { releasesToday } from "../src/brief/releases-today";
import { sinceOf } from "../src/brief/since";
import { todayHistory, todaySummary } from "../src/brief/today-summary";
import type { RepoAlerts } from "../src/facts";
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
        other: piles[1]?.notRead,
        issue: piles[1]?.notRead,
        dependabot: piles[1]?.notRead,
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
      ["other", 9, 7],
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
