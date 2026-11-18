// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { fleetLines } from "@spi-code/contracts";
import { expect, test } from "vitest";
import { todayFleet } from "../src/brief/fleet";
import { buildBriefing } from "../src/brief/index";
import { todayLines } from "../src/brief/lines";
import { rolloutVisual } from "../src/brief/place-visuals";
import { serviceHome, versionBump } from "../src/brief/service-home";
import { todaySummary } from "../src/brief/today-summary";
import type { Facts, IssueFact, PastPrFact, PrFact, RunFact } from "../src/facts";
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
    ),
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
  delete runs.syncRunJobs;
  expect(row(project(facts, now))?.cause).toContain("The failing step was not read");

  github.issues = [issue({ labels: ["sync-failed"], halt: "UNKNOWN_TOP_LEVEL: example.txt" })];
  expect(row(project(facts, now))).toBeUndefined();
  expect(project(facts, now).home.overview.some((entry) => entry.id === "halt:search")).toBe(true);
  github.issues = [];
  github.prs = [];
  github.openPrs = 0;
  expect(row(project(facts, now))).toBeUndefined();
  runs.sync = [run(121, "failure")];
  expect(row(project(facts, now))).toMatchObject({
    headline: "sync failed",
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
