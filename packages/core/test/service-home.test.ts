// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { fleetLines } from "@spi-code/contracts";
import { describe, expect, test, vi } from "vitest";
import { todayFleet } from "../src/brief/fleet";
import { buildBriefing } from "../src/brief/index";
import { todayLines } from "../src/brief/lines";
import { rolloutVisual } from "../src/brief/place-visuals";
import { serviceHome, versionBump } from "../src/brief/service-home";
import { serviceWork } from "../src/brief/service-work";
import { todaySummary } from "../src/brief/today-summary";
import type { DeploymentFact, Facts, IssueFact, PastPrFact, PrFact, RunFact } from "../src/facts";
import type { DismissEntry } from "../src/model/dismiss";
import { buildModel } from "../src/model/index";
import {
  sweep1116Context as context,
  SWEEP_1116_NOW as sweep,
  sweep1116Facts,
  sweep1116Items,
} from "./sweep-1116";

const service = "search";
const repo = `Azure/osdu-spi-${service}`;
const url = `https://github.com/${repo}`;
const merge = "2026-11-17T16:41:00Z";
const at = (iso: string) => new Date(iso).toISOString();

function pr(
  number: number,
  head: string,
  base = "main",
  createdAt = "2026-11-17T16:00:00Z",
): PrFact {
  return {
    repo,
    number,
    head,
    base,
    title: `Change #${number}`,
    url: `${url}/pull/${number}`,
    createdAt,
    updatedAt: createdAt,
    headSha: "abc",
    draft: false,
    labels: [],
    checks: [],
  };
}

function past(number: number, mergedAt?: string, head = "human", base = "main"): PastPrFact {
  const { title, url, createdAt } = pr(number, head, base);
  return { number, title, url, head, base, createdAt, mergedAt, updatedAt: "2026-11-17T19:39:00Z" };
}

function run(
  id: number,
  conclusion: string | undefined,
  createdAt = "2026-11-17T19:00:00Z",
): RunFact {
  return {
    id,
    name: "Sync Upstream",
    path: ".github/workflows/sync.yml",
    event: "schedule",
    status: conclusion ? "completed" : "in_progress",
    conclusion,
    createdAt,
    updatedAt: createdAt,
    sha: "abc",
    title: "Sync Upstream",
    url: `${url}/actions/runs/${id}`,
    attempt: 1,
  };
}

function issue(overrides: Partial<IssueFact> = {}): IssueFact {
  return {
    repo,
    number: 78,
    url: `${url}/issues/78`,
    title: "Upstream Sync Ready for Review",
    labels: ["upstream-sync", "human-required"],
    comments: 0,
    createdAt: "2026-11-17T16:00:01Z",
    updatedAt: "2026-11-17T16:00:01Z",
    ...overrides,
  };
}

function handBuilt() {
  const facts = sweep1116Facts();
  const github = facts.github.data?.repos[repo];
  const runs = facts.runs.data?.[repo];
  if (!github || !runs) throw new Error("Search facts missing");
  Object.assign(github, { prs: [], issues: [], pastPrs: [], openPrs: 0, openIssues: 0 });
  Object.assign(runs, { sync: [], cascade: [] });
  return { facts, github, runs };
}

function project(
  facts: Facts,
  now = sweep,
  versions: Parameters<typeof serviceHome>[0]["versions"] = [],
  reads: Parameters<typeof serviceHome>[0]["reads"] = {},
  dismissed: readonly DismissEntry[] = [],
) {
  const model = buildModel(facts, now, { dismissed }, context);
  const items = sweep1116Items(model);
  const lines = todayLines(model, items, now, context);
  const { canWait, causes } = todaySummary({
    model,
    facts,
    items,
    lines,
    since: undefined,
    now,
    context,
  });
  const homes = serviceHome({ model, facts, lines, items, canWait, versions, now, reads });
  const home = homes.get(service);
  if (!home) throw new Error("Search home missing");
  const briefing = buildBriefing(model, { state: "clear", problems: [] }, now, context);
  return {
    home,
    model,
    lines,
    fleet: todayFleet(
      [...homes].map(([service, home]) => ({ service, home })),
      briefing.environment,
      briefing.nextSyncAt,
      causes,
      lines,
    ),
    homes,
    briefing,
    causes,
    station: (id: (typeof home.stations)[number]["id"]) => home.stations.find((s) => s.id === id),
  };
}

test("stations and doors partition open pull request identities", () => {
  const { facts, github } = handBuilt();
  const release = pr(3, "release-please--branches--main");
  github.prs = [
    pr(1, "sync/upstream-first", "fork_upstream"),
    pr(2, "sync/upstream-second", "fork_upstream"),
    release,
    pr(4, "dependabot/package"),
    pr(5, "template-sync/update"),
    pr(6, "release/upstream-first"),
    pr(7, "release/upstream-second"),
  ];
  github.openPrs = github.prs.length;
  github.pastPrs = [past(29, merge, "release/upstream-previous")];
  const { home, station } = project(facts);
  const numbers = [
    ...home.stations.flatMap(({ pr }) => (pr ? [pr.number] : [])),
    ...home.doors.flatMap((door) => door.prs.map(({ number }) => number)),
  ];
  expect(numbers.sort()).toEqual(github.prs.map(({ number }) => number));
  expect(station("sync")?.pr?.number).toBe(1);
  expect(station("integration")?.pr?.number).toBe(6);
  expect(
    home.doors.map(({ id, prs, count }) => [id, prs.map(({ number }) => number), count]),
  ).toEqual([
    ["template", [5], 1],
    ["release", [3], 1],
    ["other", [2, 7], 2],
    ["dependabot", [4], 1],
  ]);
  expect(home.releasePr).toEqual({ number: release.number, url: release.url, age: "0s" });
  expect(home).not.toHaveProperty("next", expect.anything());
});

test("a failed or capped open-PR listing keeps counts unread, but cut checks still leave a known PR", () => {
  const { facts, github } = handBuilt();
  github.prsUnread = true;
  const unread = project(facts);
  expect(unread.home.doors.every((door) => door.count === null)).toBe(true);
  for (const id of ["sync", "integration"] as const) {
    expect(unread.station(id)).toMatchObject({ state: "unread", word: "Not read" });
  }
  delete github.prsUnread;
  github.prs = [
    ...Array.from({ length: 40 }, (_, i) => pr(i + 1, `human/${i}`)),
    pr(41, "sync/upstream-new", "fork_upstream"),
    pr(42, "template-sync/update"),
  ];
  github.openPrs = 43;
  const { home: cut, fleet, model } = project(facts);
  expect(cut.openPrTotal).toBe(43);
  expect(cut.doors.every((door) => door.count === null)).toBe(true);
  expect(cut.doors.find((door) => door.id === "other")?.prs).toHaveLength(40);
  const sync = fleet.stations.find(({ id }) => id === "sync");
  expect(sync?.notRead).toContain(service);
  expect(sync?.forks).toContain(service);
  expect(sync?.count).toBe(5);
  const review = model.queue.items.find(({ id }) => id === `gate1:${service}`);
  if (!review?.fingerprint) throw new Error("Search sync review is missing");
  const quiet = project(facts, sweep, [], {}, [{ id: review.id, fingerprint: review.fingerprint }]);
  expect(
    fleetLines(quiet.lines, "sync")
      .flatMap(({ members }) => members)
      .some(({ fork }) => fork === service),
  ).toBe(false);
  expect(quiet.fleet.stations.find(({ id }) => id === "sync")).toEqual(sync);
  expect(fleet.doors.find(({ id }) => id === "template")).toMatchObject({
    count: 1,
    forks: [service],
    notRead: [service],
    target: { kind: "station", station: "template" },
  });

  github.prs = [pr(11, "dependabot/package")];
  github.openPrs = 1;
  const reads = {
    github: [
      {
        source: "github",
        object: repo,
        observedAt: sweep.toISOString(),
        completeness: { kind: "cut" as const, read: 80, total: 81, reason: "Check context limit" },
      },
    ],
  };
  expect(
    project(facts, sweep, [], reads).home.doors.find((door) => door.id === "dependabot"),
  ).toMatchObject({ count: 1, prs: [{ number: 11 }] });
});

test("Template follows its rollout slot, and an unread source only replaces an empty mark", () => {
  const { facts } = handBuilt();
  const model = buildModel(facts, sweep, {}, context);
  const known = rolloutVisual({ facts, model })?.slots.find((s) => s.service === service)?.state;
  expect(known).toBeDefined();
  expect(project(facts).home.template).toBe(
    known === "done" ? "current" : known === "unknown" ? "unknown" : "behind",
  );

  const { home } = project(facts);
  const quiet = (input: Facts) => {
    const model = buildModel(input, sweep, {}, context);
    return serviceHome({
      model,
      facts: input,
      now: sweep,
      reads: {},
      lines: [],
      items: [],
      canWait: [],
      versions: [],
    }).get(service);
  };
  expect(home.repo).toBe(repo);
  const unknown = structuredClone(facts);
  const unknownRepo = unknown.github.data?.repos[repo];
  if (unknownRepo) delete unknownRepo.marker;
  expect(quiet(unknown)?.template).toBe("unknown");
  const absent = structuredClone(facts);
  absent.github = {};
  expect(quiet(absent)?.template).toBe("unknown");
  expect(quiet(absent)?.mark).toEqual({ kind: "unread" });
});

test.each([
  ["v1.2.3", "1.2.4", "patch"],
  ["1.2.3", "1.3.0", "minor"],
  ["1.2.3", "v2.0.0", "major"],
  ["0.3.0", "0.4.0", "minor"],
  ["1.2.3", "1.2.3", undefined],
  ["1.2.3", "1.2.2", undefined],
  ["1.2.3", "unread", undefined],
  ["1.2.3", undefined, undefined],
] as const)("classifies the version bump %s to %s", (released, proposed, expected) => {
  expect(versionBump(released, proposed)).toBe(expected);
});

test("Integration names the held sync only when both sync PR identities are known", () => {
  const { facts, github } = handBuilt();
  github.prs = [
    pr(76, "release/upstream-first", "main", "2026-11-17T17:10:00Z"),
    pr(77, "sync/upstream-new", "fork_upstream", "2026-11-17T17:20:00Z"),
  ];
  github.openPrs = 2;
  github.pastPrs = [past(72, merge, "sync/upstream-first", "fork_upstream")];
  github.issues = [
    issue({ number: 79, createdAt: "2026-11-17T17:20:01Z" }),
    issue({ labels: ["upstream-sync", "validated"] }),
  ];
  expect(project(facts, new Date("2026-11-17T17:30:00Z")).station("integration")).toMatchObject({
    word: "PR #76",
    line: "carries sync #72, not #77",
  });
  github.pastPrs = [];
  expect(project(facts).station("integration")?.line).toBeUndefined();
});

test.each(["Etc/UTC", "Asia/Kathmandu"])(
  "Cascade Monitor uses a UTC hour with the operator's clock in %s",
  (zone) => {
    const previous = process.env.TZ;
    process.env.TZ = zone;
    try {
      const { facts, github, runs } = handBuilt();
      github.pastPrs = [past(77, merge, "sync/upstream-current", "fork_upstream")];
      github.issues = [issue()];
      const read = (clock: string) => project(facts, new Date(`2026-11-17T${clock}:00Z`));
      const waiting = read("16:51");
      expect(waiting.station("integration")).toMatchObject({
        state: "waiting-on-clock",
        inTransit: true,
        nextAt: "2026-11-17T17:00:00.000Z",
        line:
          zone === "Etc/UTC"
            ? "sync #77 merged 16:41 · monitor 17:00"
            : "sync #77 merged 22:26 · monitor 22:45",
      });
      expect(waiting.home.overview.some((row) => row.id === "cascade-missed:search")).toBe(false);
      expect(
        waiting.fleet.stations.find(({ id }) => id === "integration")?.waitingOnClock,
      ).toContain("search");
      expect(read("17:14").station("integration")?.state).toBe("waiting-on-clock");
      expect(read("17:15").station("integration")?.state).toBe("waiting-on-person");
      runs.cascadeReadAt = "2026-11-17T17:14:00Z";
      expect(read("18:01").station("integration")?.state).toBe("unread");
      expect(read("18:01").home.overview.some((row) => row.id === "cascade-missed:search")).toBe(
        false,
      );
      runs.cascadeReadAt = "2026-11-17T18:01:00Z";
      const missed = read("18:01");
      expect(missed.station("integration")).toMatchObject({
        state: "waiting-on-person",
        inTransit: false,
        row: "cascade-missed:search",
      });
      expect(
        missed.fleet.stations.find(({ id }) => id === "integration")?.waitingOnPerson,
      ).toContain("search");
      expect(
        fleetLines(missed.lines, "integration")
          .flatMap(({ members }) => members)
          .find(({ id }) => id === "cascade-missed:search"),
      ).toBeDefined();
      expect(missed.home.overview.find((row) => row.id === "cascade-missed:search")).toMatchObject({
        section: "waiting",
        headline: "Cascade didn't start",
        since: "2026-11-17T17:15:00.000Z",
        links: [{ url: `${url}/actions/workflows/cascade.yml` }, { url: `${url}/issues/78` }],
      });
      runs.cascade = [run(24, undefined, "2026-11-17T17:03:00Z")];
      expect(read("18:01").station("integration")).toMatchObject({
        state: "in-progress",
        word: "Running",
      });
      expect(read("18:01").home.overview.some((row) => row.id === "cascade-missed:search")).toBe(
        false,
      );
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  },
);

test("Main names the last merge into main, ordered by merge time across PR kinds", () => {
  const { facts, github, runs } = handBuilt();
  const previous = past(76, "2026-11-17T15:22:00Z", "release/upstream-previous");
  const last = past(84, "2026-11-17T16:30:00Z");
  github.pastPrs = [
    previous,
    past(85),
    past(90, merge, "sync/upstream-next", "fork_upstream"),
    last,
  ];
  runs.main = [run(832, "success", "2026-11-17T19:30:00Z")];
  const main = project(facts, new Date("2026-11-17T20:00:00Z")).station("main");
  expect(main).toMatchObject({
    line: "PR #84 merged 16:30",
    lastMerge: { number: 84, url: last.url, at: last.mergedAt },
  });
});

test.each([
  [
    "seven local dates back, under 168 hours",
    "2026-11-09T16:00:00Z",
    "2026-11-16T15:00:00Z",
    "9 Nov",
  ],
  [
    "six local dates back across the DST change",
    "2026-10-26T05:01:00Z",
    "2026-11-02T05:01:00Z",
    "Mon 00:01",
  ],
])("Main reads a merge %s on the window's clock", (_, mergedAt, now, expected) => {
  const previous = process.env.TZ;
  process.env.TZ = "America/Chicago";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse(now) + 400 * 86_400_000);
  try {
    const { facts, github } = handBuilt();
    github.pastPrs = [past(84, mergedAt)];
    expect(project(facts, new Date(now)).station("main")?.line).toBe(`PR #84 merged ${expected}`);
  } finally {
    vi.useRealTimers();
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("an open sync PR and an unsettled failure raise one Blocked row with the failed step", () => {
  const { facts, github, runs } = handBuilt();
  const now = new Date("2026-11-17T20:00:00Z");
  github.prs = [pr(77, "sync/upstream-current", "fork_upstream")];
  github.openPrs = 1;
  runs.sync = [
    run(123, undefined, "2026-11-17T19:03:00Z"),
    run(122, "cancelled", "2026-11-17T19:02:00Z"),
    run(121, "failure"),
  ];
  runs.syncRunJobs = {
    "121#1": [
      {
        id: 83,
        name: "Build",
        status: "completed",
        conclusion: "failure",
        url: `${url}/actions/runs/121/job/83`,
        steps: [],
        failedStep: "Resolve Maven BOMs",
      },
    ],
  };
  const result = project(facts, now);
  const row = (value: typeof result) =>
    value.home.overview.find(({ id }) => id === "sync-run:search");
  expect(row(result)).toMatchObject({
    section: "blocked",
    headline: "Sync failed",
    cause: expect.stringContaining("Build › Resolve Maven BOMs"),
  });
  expect(
    result.lines.find((line) => line.members.some((m) => m.id === "sync-run:search"))?.members[0]
      ?.home,
  ).toBe("line");
  expect(result.home.mark).toMatchObject({ kind: "count", tone: "error" });
  expect(result.station("upstream")?.word).toBe("Sync failed");
  delete runs.syncRunJobs;
  expect(row(project(facts, now))?.cause).toContain("The failing step was not read");

  github.issues = [issue({ labels: ["sync-failed"], halt: "UNKNOWN_TOP_LEVEL: example.txt" })];
  expect(row(project(facts, now))).toBeUndefined();
  expect(project(facts, now).home.overview.some((entry) => entry.id === "halt:search")).toBe(true);
  const halted = project(facts, now);
  expect(halted.station("upstream")).toMatchObject({ state: "stopped", word: "Sync halted" });
  expect(halted.station("upstream")?.line).toMatch(/^10 behind · next sync /);
  const lag = facts.upstream.data?.[service];
  if (lag) delete lag.lag;
  expect(project(facts, now).station("upstream")?.line).toMatch(/^next sync /);
  expect(halted.station("sync")).toMatchObject({ word: "PR #77", pr: { number: 77 } });
  github.issues = [];
  github.prs = [];
  github.openPrs = 0;
  expect(row(project(facts, now))).toBeUndefined();
  runs.sync = [run(121, "failure")];
  expect(row(project(facts, now))).toMatchObject({
    headline: "Sync failed",
    cause: "Sync Upstream failed with no halt issue open.",
  });
});

test("Can wait is deduplicated and oldest first, and a door opens the earliest qualifying row", () => {
  const { facts, github } = handBuilt();
  const older = pr(52, "dependabot/old", "main", at("2026-11-16T12:00:00Z"));
  const newer = pr(60, "dependabot/new", "main", at("2026-11-17T12:00:00Z"));
  github.prs = [newer, older];
  github.openPrs = 2;
  const { home } = project(facts, new Date("2026-11-17T20:00:00Z"));
  const rows = home.overview.filter(
    (row) =>
      row.section === "can-wait" &&
      row.links.some((link) => link.url === older.url || link.url === newer.url),
  );
  expect(rows.map((row) => row.links[0]?.url)).toEqual([older.url, newer.url]);
  expect(home.doors.find((door) => door.id === "dependabot")?.row).toBe(rows[0]?.id);
});

test("Overview uses Today's sentence case for Can wait PR and issue headlines", () => {
  const { facts, github } = handBuilt();
  const change = { ...pr(52, "human/audit"), title: "chore: audit manifests" };
  const task = issue({ title: "review settings", labels: ["human-required"] });
  github.prs = [change];
  github.issues = [task];
  github.openPrs = 1;
  github.openIssues = 1;
  const { home, causes } = project(facts, new Date("2026-11-17T20:00:00Z"));
  for (const [object, headline] of [
    [change, "Chore: audit manifests"],
    [task, "Review settings"],
  ] as const) {
    const row = home.overview.find(
      ({ section, links }) => section === "can-wait" && links.some(({ url }) => url === object.url),
    );
    const cause = causes.rows.find(({ forks }) =>
      forks.some(({ objects }) => objects.some(({ url }) => url === object.url)),
    );
    expect(row?.headline).toBe(headline);
    expect(cause?.headline).toBe(headline);
  }
});

test("service work preserves the forge total and marks cut and unread listings honestly", () => {
  const { facts, github } = handBuilt();
  github.prs = Array.from({ length: 40 }, (_, index) => pr(index + 1, `test/${index}`));
  github.openPrs = 41;
  const work = () =>
    serviceWork(buildModel(facts, sweep, {}, context), facts, {}, new Map()).get(service);
  expect(work()?.pulls).toMatchObject({ count: 41, partial: true, read: true });
  expect(work()?.pulls.rows).toHaveLength(40);
  github.prsUnread = true;
  github.issuesUnread = true;
  expect(work()?.pulls).toMatchObject({ count: null, read: true });
  expect(work()?.issues).toMatchObject({ count: null, read: true });
});

describe("a failed GitHub read of a fork", () => {
  const readAt = "2026-11-16T07:38:00.000Z";
  const failure = (retainedFrom?: string, object = repo) => ({
    github: [
      {
        source: "github",
        object,
        observedAt: sweep.toISOString(),
        completeness: { kind: "complete" } as const,
        failure: "GitHub unavailable",
        ...(retainedFrom ? { retainedFrom } : {}),
      },
    ],
  });
  const held = () => {
    const { facts, github } = handBuilt();
    github.prs = [pr(73, "feature/one"), pr(75, "feature/two")];
    github.openPrs = 2;
    github.pastPrs = [past(70, merge)];
    github.issues = [issue({ number: 33, labels: ["bug"], url: `${url}/issues/33` })];
    github.openIssues = 1;
    return { facts, github };
  };
  const work = (facts: Facts, reads: Parameters<typeof serviceWork>[2]) =>
    serviceWork(buildModel(facts, sweep, {}, context), facts, reads, new Map()).get(service);

  test("keeps the retained rows, unread, with the time they were read", () => {
    const { facts } = held();
    const result = work(facts, failure(readAt));
    expect(result?.pulls).toMatchObject({ count: 2, read: false, at: readAt });
    expect(result?.pulls.rows.map(({ number }) => number)).toEqual([73, 75, 70]);
    expect(result?.issues).toMatchObject({ count: 1, read: false, at: readAt });
    expect(result?.issues.rows.map(({ number }) => number)).toEqual([33]);
  });

  test("keeps retained rows with no time unread and timeless", () => {
    const { facts } = held();
    const result = work(facts, failure());
    expect(result?.pulls).toMatchObject({ count: 2, read: false });
    expect(result?.pulls.rows).toHaveLength(3);
    expect(result?.issues.rows).toHaveLength(1);
    expect(result?.pulls).not.toHaveProperty("at");
    expect(result?.issues).not.toHaveProperty("at");
  });

  test("with nothing retained gives no rows and no count", () => {
    const { facts } = held();
    delete facts.github.data?.repos[repo];
    const result = work(facts, failure());
    expect(result?.pulls).toEqual({
      count: null,
      partial: false,
      pastRead: false,
      read: false,
      rows: [],
    });
    expect(result?.issues).toMatchObject({ count: null, read: false, rows: [] });
  });

  test("keeps a retained capped list's count unread beside its held rows", () => {
    const { facts, github } = held();
    github.prs = Array.from({ length: 40 }, (_, index) => pr(index + 1, `test/${index}`));
    github.openPrs = 41;
    github.openIssues = 3;
    const result = work(facts, failure(readAt));
    expect(result?.pulls).toMatchObject({ count: null, partial: true, read: false, at: readAt });
    expect(result?.pulls.rows.filter(({ state }) => state === "open")).toHaveLength(40);
    expect(result?.issues).toMatchObject({ count: null, partial: true, read: false });
    expect(result?.issues.rows).toHaveLength(1);
  });

  test("never reads true while the area failed, with or without a record for the fork", () => {
    const { facts } = held();
    facts.github.error = "GitHub unavailable";
    for (const reads of [{}, failure(readAt)]) {
      const result = work(facts, reads);
      expect(result?.pulls.read).toBe(false);
      expect(result?.issues.read).toBe(false);
    }
  });

  test("of closed issues alone leaves the open lists read and the closed history unread", () => {
    const { facts } = held();
    const result = work(facts, failure(undefined, `${repo}@closed-issues`));
    expect(result?.pulls).toMatchObject({ count: 2, read: true });
    expect(result?.issues).toMatchObject({ count: 1, read: true, closedRead: false });
  });

  test("orders the recent closed issues by their close date after the open rows", () => {
    const { facts, github } = held();
    github.closedIssues = [
      { ...issue({ number: 79, url: `${url}/issues/79` }), closedAt: sweep.toISOString() },
      { ...issue({ number: 80, url: `${url}/issues/80` }), closedAt: merge },
    ];
    expect(work(facts, {})?.issues.rows.map(({ number }) => number)).toEqual([33, 80, 79]);
  });

  test("of the repository and its closed issues never reads the retained closed history", () => {
    const { facts, github } = held();
    github.closedIssues = [{ ...issue({ number: 79, url: `${url}/issues/79` }), closedAt: merge }];
    const repoFailed = failure(readAt).github;
    const closedFailed = failure(undefined, `${repo}@closed-issues`).github;
    expect(work(facts, { github: repoFailed })?.issues.closedRead).toBe(true);
    const result = work(facts, { github: [...repoFailed, ...closedFailed] });
    expect(result?.issues).toMatchObject({ count: 1, read: false, closedRead: false });
    expect(result?.issues.rows.map(({ number }) => number)).toEqual([33]);
  });
});

test("a Can wait PR row says what it needs in the Pull requests tab's words, and nothing it cannot read", () => {
  const { facts, github } = handBuilt();
  const behind = { ...pr(61, "dependabot/one"), mergeState: "BEHIND" };
  const review = {
    ...pr(62, "dependabot/two"),
    mergeState: "BLOCKED",
    reviewDecision: "REVIEW_REQUIRED",
    reviewers: { requested: ["maintainers"], latest: [], cut: false },
  };
  const unread = pr(63, "dependabot/three");
  github.prs = [behind, review, unread];
  github.openPrs = 3;
  const { home, model } = project(facts);
  const gate = (pull: PrFact) => {
    const row = home.overview.find(({ links }) => links[0]?.url === pull.url);
    expect(row?.section).toBe("can-wait");
    return row?.gate;
  };
  expect(gate(behind)).toBe("Update branch");
  expect(gate(review)).toBe("Review required");
  expect(gate(unread)).toBeUndefined();
  const tab = serviceWork(model, facts, {}, new Map([[service, home]])).get(service)?.pulls.rows;
  for (const pull of [behind, review, unread]) {
    const row = tab?.find(({ number }) => number === pull.number);
    expect(row && "gate" in row ? row.gate : undefined).toBe(gate(pull));
  }
});

test("the recorded 16 Nov sweep reads open issues without claiming a closed-issues read", () => {
  const facts = sweep1116Facts();
  const model = buildModel(facts, sweep, {}, context);
  const work = serviceWork(model, facts, {}, new Map()).get(service);
  expect(work?.issues).toMatchObject({ count: expect.any(Number), closedRead: false });
  expect(work?.issues.rows).toContainEqual(
    expect.objectContaining({ number: 78, tracks: { number: 77, url: `${url}/pull/77` } }),
  );
  expect(work?.issues.count).toBe((work?.issues.rows.length ?? 0) - 1);
});

test("a Ready for Review issue rides on its merged sync PR only while the match is unique", () => {
  const { facts, github } = handBuilt();
  const merged = past(77, merge, "sync/upstream-current", "fork_upstream");
  github.pastPrs = [merged];
  github.issues = [issue()];
  github.closedIssues = [{ ...issue({ number: 79, url: `${url}/issues/79` }), closedAt: merge }];
  github.openIssues = 1;
  const work = () =>
    serviceWork(buildModel(facts, sweep, {}, context), facts, {}, new Map()).get(service);
  expect(work()?.pulls.rows).toContainEqual(
    expect.objectContaining({
      number: 77,
      state: "merged",
      companion: { number: 78, url: `${url}/issues/78` },
    }),
  );
  expect(work()?.issues).toMatchObject({
    count: 0,
    closedRead: true,
    rows: [
      { number: 78, state: "open", tracks: { number: 77, url: merged.url } },
      { number: 79, state: "closed", closedAt: merge },
    ],
  });

  github.pastPrs.push(past(76, merge, "sync/upstream-another", "fork_upstream"));
  expect(work()?.issues.count).toBe(1);
  expect(work()?.issues.rows[0]?.tracks).toBeUndefined();
  github.pastPrs = [merged];
  github.issues = [issue({ createdAt: "2026-11-17T17:00:00Z" })];
  expect(work()?.issues.count).toBe(1);
});

test("a review requirement says No reviewer only after reading both reviewer lists", () => {
  const { facts, github } = handBuilt();
  const pull = { ...pr(51, "feature/change"), reviewDecision: "REVIEW_REQUIRED" };
  github.openPrs = 1;
  const row = (reviewers?: PrFact["reviewers"]) => {
    github.prs = [{ ...pull, reviewers }];
    return serviceWork(buildModel(facts, sweep, {}, context), facts, {}, new Map()).get(service)
      ?.pulls.rows[0];
  };
  expect(row()).toMatchObject({ gate: "Review required" });
  expect(row({ requested: [], latest: [], cut: true })).toMatchObject({
    gate: "Review required",
    reviewersCut: true,
  });
  expect(row({ requested: [], latest: [], cut: false })).toMatchObject({ gate: "No reviewer" });
  expect(
    row({ requested: ["maintainers"], latest: [{ login: "ren", state: "APPROVED" }], cut: false }),
  ).toMatchObject({
    gate: "Review required",
    reviewers: ["maintainers", "ren"],
  });
});

test("the Template door opens its filter while Yours holds a Template row, even with no PR to review", () => {
  const { facts } = handBuilt();
  const { fleet, lines, homes, briefing, causes } = project(facts);
  const held = fleetLines(lines, "template").flatMap(({ members }) => members);
  expect(held.map(({ fork }) => fork)).toEqual(["fleet"]);
  const door = fleet.doors.find(({ id }) => id === "template");
  expect(door).toMatchObject({ count: 0, target: { kind: "station", station: "template" } });
  const quiet = todayFleet(
    [...homes].map(([service, home]) => ({ service, home })),
    briefing.environment,
    briefing.nextSyncAt,
    causes,
    lines.filter(({ members }) => !members.some(({ station }) => station === "template")),
  );
  expect(quiet.doors.find(({ id }) => id === "template")).not.toHaveProperty("target");
});

test("a station's red forks are its stopped forks holding a PR, never a stopped cascade", () => {
  const { facts } = handBuilt();
  const { homes, briefing, causes } = project(facts);
  const [base] = homes.values();
  if (!base) throw new Error("a home");
  const withIntegration = (state: "stopped" | "ready", pr?: number) => ({
    ...base,
    stations: base.stations.map((station) =>
      station.id === "integration"
        ? {
            id: station.id,
            state,
            word: "",
            ...(pr ? { pr: { number: pr, url: `${url}/pull/${pr}` } } : {}),
          }
        : station,
    ),
  });
  const fleet = todayFleet(
    [
      { service: "unit", home: withIntegration("ready", 1) },
      { service: "search", home: withIntegration("stopped") },
      { service: "legal", home: withIntegration("stopped", 2) },
    ],
    briefing.environment,
    briefing.nextSyncAt,
    causes,
  );
  expect(fleet.stations.find(({ id }) => id === "integration")).toMatchObject({
    forks: ["unit", "legal"],
    stopped: ["search", "legal"],
    red: ["legal"],
  });
});

describe("a red Main", () => {
  const failedAt = "2026-11-17T19:46:00Z";
  const now = new Date("2026-11-17T20:00:00Z");
  function redMain(deployment: Partial<DeploymentFact> = {}) {
    const { facts, github, runs } = handBuilt();
    const [head] = runs.main;
    const jobs = head && runs.mainRunJobs?.[head.id];
    if (!head || !jobs) throw new Error("Search main run missing");
    const failed = { ...head, conclusion: "failure", updatedAt: failedAt };
    const deploy = jobs.find((job) => job.name === "Deploy and Test");
    const summary = jobs.find((job) => job.name === "Validation Summary");
    if (!deploy || !summary) throw new Error("Search main jobs missing");
    Object.assign(deploy, {
      conclusion: "failure",
      failedStep: "Prove",
      environment: ["environment timeout"],
    });
    Object.assign(summary, { conclusion: "failure", environment: [] });
    for (const job of jobs) job.environment ??= [];
    runs.main = [failed, ...runs.main.slice(1)];
    github.deployments = [
      {
        createdAt: "2026-11-17T19:30:00Z",
        ref: "main",
        sha: head.sha,
        state: "FAILURE",
        statusAt: "2026-11-17T19:44:00Z",
        runUrl: head.url,
        jobId: deploy.id,
        ...deployment,
      },
    ];
    return { facts, runs, head: failed, jobs };
  }
  const yours = (result: ReturnType<typeof project>) =>
    result.home.overview.filter(({ section }) => section === "blocked" || section === "waiting");
  const members = (result: ReturnType<typeof project>) =>
    result.lines
      .flatMap(({ members }) => members)
      .filter(({ fork }) => fork === service)
      .map(({ id }) => id)
      .sort();

  test("leads Blocked with its attempt, cause, verdict, Next and the lane deploy it folded on proof", () => {
    const { facts, head } = redMain();
    const result = project(facts, now);
    const [row] = result.home.overview;
    expect(row).toMatchObject({
      id: "main:search",
      section: "blocked",
      failure: {
        path: "Validation › Deploy and Test › Prove",
        reason: "environment timeout",
        verdict: "Environment",
      },
      evidence: expect.stringMatching(/^Lane deploy failed \S+ in attempt 1$/),
      jobs: "Failed in attempt 1: Deploy and Test (Prove). Validation Summary repeats it.",
      next: "Re-run the failed jobs once. If it fails again, diagnose.",
    });
    expect(row?.links[0]).toEqual({
      label: "Attempt 1",
      url: `${head.url}/attempts/1`,
      kind: "run",
    });
    expect(result.model.queue.items.some(({ id }) => id === "lane-deploy:search")).toBe(false);
    expect(members(result)).toEqual(
      yours(result)
        .map(({ id }) => id)
        .sort(),
    );
    expect(result.home.mark).toMatchObject({
      kind: "count",
      count: yours(result).length,
      tone: "error",
    });
    expect(result.station("main")).toMatchObject({
      state: "stopped",
      word: "Red",
      row: "main:search",
    });
    expect(result.station("main")?.line).toMatch(/^Validation failed /);
  });

  test.each([
    ["a shared commit alone", { jobId: undefined }],
    ["a job of another attempt", { jobId: 1 }],
    [
      "another repository's run",
      { runUrl: "https://github.com/Azure/osdu-spi-legal/actions/runs/42747639175" },
    ],
  ])("keeps both rows and counts on %s", (_, deployment) => {
    const { facts } = redMain(deployment);
    const result = project(facts, now);
    expect(result.home.overview.find(({ id }) => id === "main:search")).not.toHaveProperty(
      "evidence",
    );
    expect(result.model.queue.items.some(({ id }) => id === "lane-deploy:search")).toBe(true);
    expect(members(result)).toContain("lane-deploy:search");
    expect(members(result)).toEqual(
      yours(result)
        .map(({ id }) => id)
        .sort(),
    );
    expect(result.home.mark).toMatchObject({ kind: "count", count: yours(result).length });
  });

  test("stays Blocked on the failed attempt while attempt 2 runs, and never offers a rerun on an unread list", () => {
    const { facts, runs, head, jobs } = redMain();
    runs.main = [
      { ...head, status: "in_progress", conclusion: undefined, attempt: 2 },
      ...runs.main.slice(1),
    ];
    runs.mainRunJobs = { [`${head.id}#1`]: jobs };
    const flying = project(facts, now);
    expect(flying.home.overview[0]).toMatchObject({
      id: "main:search",
      section: "blocked",
      rerunning: true,
      failure: { verdict: "Environment" },
      next: "Re-run in flight (attempt 2). If it fails again, diagnose the failed jobs.",
    });
    expect(flying.home.overview[0]?.links[0]).toMatchObject({
      label: "Attempt 2",
      url: `${head.url}/attempts/2`,
    });
    expect(flying.station("main")).toMatchObject({
      state: "stopped",
      line: "Validation re-running · attempt 2",
    });

    runs.main = [head, ...runs.main.slice(1)];
    runs.mainRunJobs = { [head.id]: jobs };
    runs.mainJobsCut = [`${head.id}#1`];
    expect(project(facts, now).home.overview[0]).toMatchObject({
      failure: { verdict: "Not read" },
      next: "Cause not read yet. Open the run attempt, or ask Copilot to diagnose.",
    });
  });
});
