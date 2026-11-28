// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import {
  fleetLines,
  type TodayMemberStation,
  todayCounts,
  todayMembers,
  ViewSnapshotSchema,
} from "@spi-code/contracts";
import { describe, expect, test } from "vitest";
import { watchFixtures } from "../../../scripts/watch-generated.mjs";
import { buildBriefing } from "../src/brief/index";
import {
  orderTodayLines,
  type TodayLine,
  todayInFlight,
  todayLineFailing,
  todayLines,
} from "../src/brief/lines";
import { classifyRolloutForks, rolloutTally } from "../src/brief/rollout";
import { emptyFacts, type Facts } from "../src/facts";
import { itemEvidence } from "../src/inspect/item-evidence";
import { CLASS_VERB } from "../src/model/next";
import sweep1106 from "./fixtures/upstream-1106.json";
import {
  sweep1116Context as context,
  SWEEP_1116_NOW as now,
  sweep1116Items,
  sweep1116Model,
} from "./sweep-1116";

const model = sweep1116Model();
const items = sweep1116Items(model);
const lines = todayLines(model, items, now, context);
const lineWith = (id: string) => lines.find((line) => line.members.some((m) => m.id === id));
const stations = ["upstream", "sync", "integration", "template"] as const;
const expectedHoming: Readonly<Record<string, TodayMemberStation>> = {
  halt: "upstream",
  radar: "upstream",
  "sync-run": "upstream",
  gate1: "sync",
  conflict: "integration",
  cascade: "integration",
  "cascade-missed": "integration",
  labels: "integration",
  gate2: "integration",
  "lane-deploy": "integration",
  stack: "integration",
  rollout: "template",
  "template-pr": "template",
  "template-red": "template",
  "template-set": "template",
  "template-run": "template",
};

const SWEEP = "apps/window/src/views/today/snapshot-1116.json";
const recordedMornings = () => [
  ...watchFixtures().filter(({ name }) => name.startsWith("snapshot-")),
  { name: "16 Nov", path: SWEEP },
];

function snapshotAt(path: string) {
  return ViewSnapshotSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

describe("Today's situation lines", () => {
  test("16 Nov has 10 lines and 18 members, and all mornings put the same members in fork homes", () => {
    expect(lines).toHaveLength(10);
    expect(lines.flatMap((line) => line.members)).toHaveLength(17);
    expect(
      lines.filter((line) => line.section === "blocked").flatMap((l) => l.members),
    ).toHaveLength(3);
    expect(
      lines.filter((line) => line.section === "waiting").flatMap((l) => l.members),
    ).toHaveLength(14);
    expect(
      lines
        .flatMap(({ members }) => members)
        .filter(({ ids }) => ids.some((id) => id.startsWith("port:"))),
    ).toHaveLength(0);
    const fixtures = recordedMornings();
    expect(fixtures.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "snapshot-calm.json",
        "snapshot-busy.json",
        "snapshot-bad.json",
        "16 Nov",
      ]),
    );
    for (const { name, path } of fixtures) {
      const snapshot = snapshotAt(path);
      const services = (snapshot.services ?? []).map(({ service, home }) => {
        if (!home) throw new Error(`${name}: ${service} is missing its home`);
        return { service, home };
      });
      const entries = todayMembers(snapshot.briefing);
      const rows = services.flatMap(({ service, home }) =>
        home.overview.map((row) => ({ ...row, service })),
      );
      const ports = snapshot.briefing.horizon.owed?.services ?? [];
      for (const { line, member } of entries) {
        if (member.ids.some((id) => id.startsWith("port:"))) {
          expect(
            rows
              .filter((row) => row.id === member.id)
              .map((row) => [row.section, row.service])
              .sort(),
            name,
          ).toEqual(ports.map(({ service }) => ["shared", service]).sort());
        } else if (services.some(({ service }) => service === member.fork)) {
          expect(
            rows.filter((row) => row.id === member.id),
            name,
          ).toMatchObject([
            { service: member.fork, section: line.section, headline: line.headline },
          ]);
          expect(
            rows.filter((row) => row.id === member.id),
            name,
          ).toHaveLength(1);
          const links = rows.find((row) => row.id === member.id)?.links;
          if (member.primary && member.id.startsWith("main:")) {
            expect(links?.[0], name).toMatchObject({
              kind: "run",
              url: expect.stringMatching(/\/attempts\/\d+$/),
            });
            expect(links, name).toContainEqual(member.primary);
          } else if (member.primary) expect(links?.[0], name).toEqual(member.primary);
        }
      }
      for (const { service, home } of services) {
        const yours = home.overview.filter(
          ({ section }) => section === "blocked" || section === "waiting",
        );
        expect(home.mark.kind === "count" ? home.mark.count : 0, `${name} ${service}`).toBe(
          yours.length,
        );
        if (home.mark.kind === "count")
          expect(home.mark.tone).toBe(
            yours.some((r) => r.section === "blocked") ? "error" : "warning",
          );
        const known = [
          ...home.stations.flatMap(({ pr }) => (pr ? [pr.number] : [])),
          ...home.doors.flatMap(({ prs }) => prs.map((pr) => pr.number)),
        ];
        expect(new Set(known).size, `${name} ${service}`).toBe(known.length);
        if (home.openPrTotal !== undefined && home.doors.every((door) => door.count !== null))
          expect(known.length, `${name} ${service}`).toBe(home.openPrTotal);
      }
    }
  });

  test("every morning's fleet agrees with its service homes and filters Today by member", () => {
    for (const { name, path } of recordedMornings()) {
      const snapshot = snapshotAt(path);
      const fleet = snapshot.briefing.today?.fleet;
      if (!fleet || !snapshot.services) throw new Error(`${name} lacks fleet homes`);
      expect(fleet.stations.map(({ id }) => id)).toEqual([
        "upstream",
        "sync",
        "integration",
        "main",
      ]);
      expect(fleet.doors.map(({ id }) => id)).toEqual([
        "template",
        "release",
        "dependabot",
        "other",
      ]);
      for (const { id, count, forks, notRead } of fleet.stations) {
        const held = snapshot.services.flatMap(({ service, home }) => {
          const at = home?.stations.find((station) => station.id === id);
          return (
            id === "upstream"
              ? at?.state === "stopped"
              : id === "main"
                ? at?.state === "green"
                : at?.pr !== undefined
          )
            ? [service]
            : [];
        });
        expect([count, forks], `${name} ${id}`).toEqual([held.length, held]);
        expect(notRead, `${name} ${id}`).toEqual(
          snapshot.services.flatMap(({ service, home }) => {
            const at = home?.stations.find((station) => station.id === id);
            return !at || at.state === "unread" || at.notRead ? [service] : [];
          }),
        );
      }
      for (const figure of fleet.doors) {
        const held = snapshot.services.map(({ service, home }) => ({
          service,
          door: home?.doors.find(({ id }) => id === figure.id),
        }));
        expect(figure.count, name).toBe(
          held.reduce((total, { door }) => total + (door?.count ?? door?.prs.length ?? 0), 0),
        );
        expect(figure.forks, name).toEqual(
          held.filter(({ door }) => door?.prs.length).map(({ service }) => service),
        );
        expect(figure.notRead, name).toEqual(
          held.filter(({ door }) => door?.count == null).map(({ service }) => service),
        );
      }
      const entries = todayMembers(snapshot.briefing);
      for (const { member } of entries) {
        const kind = member.id.split(":")[0] ?? "";
        const expected =
          kind === "stack" && member.id !== "stack:lanes" ? undefined : expectedHoming[kind];
        expect(member.station, `${name} ${member.id}`).toBe(expected);
      }
      for (const station of stations) {
        const filtered = fleetLines(snapshot.briefing.lines ?? [], station);
        expect(
          todayMembers({ lines: filtered }).map(({ member }) => member.id),
          `${name} ${station}`,
        ).toEqual(
          entries.filter(({ member }) => member.station === station).map(({ member }) => member.id),
        );
      }
      for (const { service, home } of snapshot.services) {
        expect(fleet.forks.yours.includes(service), name).toBe(home?.mark.kind === "count");
        expect(fleet.forks.rest.forks.includes(service), name).toBe(home?.mark.kind !== "count");
      }
    }
  });

  test("the 16 Nov sweep puts the recorded PRs, sync failures and healthy mains at their stations", () => {
    const snapshot = snapshotAt(SWEEP);
    const fleet = snapshot.briefing.today?.fleet;
    expect(fleet?.stations.map(({ id, forks }) => [id, forks])).toEqual([
      ["upstream", ["indexer", "search", "crs-conversion"]],
      ["sync", ["search", "workflow", "unit", "crs-catalog", "crs-conversion"]],
      [
        "integration",
        [
          "partition",
          "entitlements",
          "legal",
          "schema",
          "storage",
          "indexer",
          "search",
          "indexer-queue",
        ],
      ],
      [
        "main",
        [
          "partition",
          "entitlements",
          "legal",
          "schema",
          "file",
          "storage",
          "indexer",
          "search",
          "workflow",
          "indexer-queue",
          "unit",
          "crs-catalog",
          "crs-conversion",
        ],
      ],
    ]);
    expect(fleet?.stations.find(({ id }) => id === "integration")?.stopped).toEqual([
      "entitlements",
      "legal",
      "schema",
      "storage",
      "indexer",
      "indexer-queue",
    ]);
    expect(fleet?.environment).toEqual({ state: "ready", version: "v0.35.5", notRead: [] });
    const causes = snapshot.briefing.today?.causes?.rows ?? [];
    expect(
      fleet?.doors.map(({ id, count, target }) => [
        id,
        count,
        target?.kind === "cause" && target.row,
      ]),
    ).toEqual([
      ["template", 0, false],
      ["release", 12, "release"],
      ["dependabot", 26, "dependabot"],
      ["other", 7, causes.find(({ kind, forks }) => kind === "other" && forks.length === 7)?.id],
    ]);
    const run = "https://github.com/Azure/osdu-spi-indexer/actions/runs/43988443150";
    const issue = "https://github.com/Azure/osdu-spi-indexer/issues/72";
    expect(
      todayMembers(snapshot.briefing).find(({ member }) => member.id === "sync-run:indexer"),
    ).toMatchObject({
      line: { headline: "Sync Upstream failed with halt issue #72 open" },
      member: { station: "upstream", primary: { url: issue, kind: "issue" } },
    });
    const indexer = snapshot.services?.find(({ service }) => service === "indexer")?.home;
    expect(indexer?.stations.find(({ id }) => id === "upstream")).toMatchObject({
      row: "sync-run:indexer",
    });
    expect(indexer?.overview.find(({ id }) => id === "sync-run:indexer")?.links).toMatchObject([
      { url: issue, kind: "issue" },
      { url: run, kind: "run" },
    ]);
  });

  test("five red PRs take their blocker's move and keep the lane condition before the merge", () => {
    const line = lineWith("gate2:legal");
    expect(line?.members.map((m) => m.fork)).toEqual([
      "indexer-queue",
      "legal",
      "entitlements",
      "schema",
      "indexer",
    ]);
    expect(line).toMatchObject({
      subject: "5 forks",
      headline: "Integration PR red: its deploy lane failed",
      steps: [
        "Re-run the failed lanes once the others drain.",
        "Approve and merge each PR once it is green.",
      ],
    });
    expect(line?.deadline).toBeUndefined();
    const member = line?.members.find((m) => m.fork === "legal");
    expect(member?.primary).toMatchObject({
      kind: "pr",
      url: "https://github.com/Azure/osdu-spi-legal/pull/90",
    });
    expect(member?.evidence).toEqual(itemEvidence(model, ["gate2:legal", "stack:lanes"]));
    expect(member?.evidence.notRead).toContain("Whether the other lanes have drained");
    expect(lines.flatMap((l) => l.members).some((m) => m.id === "stack:lanes")).toBe(false);
  });

  test("four sync PR objects each hold upgrade then review, dated by the PR", () => {
    const line = lineWith("gate1:unit");
    expect(line?.members.map((m) => m.fork)).toEqual(["unit", "workflow", "crs-catalog", "search"]);
    expect(line).toMatchObject({
      subject: "4 forks",
      headline: "Sync PR needs os-core-common upgraded on the fork first",
      age: "10d",
      steps: ["Upgrade os-core-common in the fork's pom.xml.", "Review and merge the sync PR."],
    });
    expect(line?.members[0]).toMatchObject({
      home: "line",
      id: "gate1:unit",
      ids: ["radar:unit", "gate1:unit"],
      age: "10d",
      primary: { kind: "pr", url: "https://github.com/Azure/osdu-spi-unit/pull/50" },
    });
    expect(line?.members[0]?.steps[0]).toBe(
      "Upgrade os-core-common 8.5.0 on the fork before merging sync PR #50.",
    );
  });

  test("member steps follow Today's wording, one step or many", () => {
    const members = watchFixtures()
      .filter(({ name }) => name.startsWith("snapshot-"))
      .flatMap(({ path }) => (snapshotAt(path).briefing.lines ?? []).flatMap((l) => l.members));
    for (const member of members)
      if (!member.id.startsWith("rollout:")) expect(member.steps.length).toBeGreaterThan(0);
    const steps = members.flatMap((m) => m.steps);
    for (const step of steps) expect(step).not.toMatch(/(^|\. )(Absorb|Pre-classify)\b|\S › \S/);
    expect(steps).toContain(
      "Open the failed job (Java Build, step Build); the reason is in the cause above.",
    );
    expect(steps).toContain(
      "Add schemathesis-tests to top_level in .github/upstream-filter.yml before the next Sync Upstream.",
    );
    expect(steps).toContain("Upgrade os-core-common 8.5.0 on the fork before merging sync PR #58.");
  });

  test("a proved cause sits beside the headline only when the read names the step", () => {
    const run = (m: typeof model) => m.queue.items.find(({ kind }) => kind === "sync-run");
    const line = (m: typeof model) =>
      todayLines(m, sweep1116Items(m), now, context).find((l) =>
        l.members.some(({ id }) => id === run(m)?.id),
      );
    const withReason = (value: string | undefined) => {
      const changed = structuredClone(model);
      const q = run(changed);
      if (!q) throw new Error("16 Nov has a sync run");
      q.cause = [
        ...q.cause.filter(({ label }) => label !== "reason"),
        ...(value ? [{ label: "reason", value }] : []),
      ];
      return line(changed);
    };
    expect(withReason("Sync Upstream failed at sync › Merge upstream")?.proved).toBe(
      "at Merge upstream",
    );
    expect(withReason("Sync Upstream failed")).toBeDefined();
    expect(withReason("Sync Upstream failed")?.proved).toBeUndefined();
    expect(withReason(undefined)?.proved).toBeUndefined();
  });

  test("radar-only toolchain objects group by dependency without claiming a sync PR", () => {
    const withoutPrs = items.filter(
      (i) => !["gate1:unit", "gate1:workflow", "gate1:search"].includes(i.id),
    );
    const result = todayLines(model, withoutPrs, now, context);
    const group = result.find((line) => line.members.some((m) => m.id === "radar:unit"));
    expect(group).toMatchObject({
      id: "waiting:toolchain:os-core-common",
      subject: "3 forks",
      headline: "Upstream changes need a toolchain upgrade",
      steps: [],
    });
    expect(group?.members.map((m) => m.id).sort()).toEqual([
      "radar:search",
      "radar:unit",
      "radar:workflow",
    ]);
    expect(group?.headline).not.toContain("sync PR");
    expect(group?.members.every((member) => member.home === "upstream")).toBe(true);
    const changed = structuredClone(model);
    const value = changed.queue.items
      .find((q) => q.id === "radar:search")
      ?.cause.find((f) => f.label === "value");
    if (!value) throw new Error("search has a toolchain dependency");
    value.value = value.value.replace("os-core-common", "another-dependency");
    const separate = todayLines(
      changed,
      withoutPrs.filter((i) => i.cls === "TOOLCHAIN"),
      now,
      context,
    );
    expect(separate.map((line) => line.id).sort()).toEqual([
      "waiting:toolchain:another-dependency",
      "waiting:toolchain:os-core-common",
    ]);
  });

  test("sync and release PRs behind the same lanes keep their own situations", () => {
    const changed = structuredClone(model);
    const sync = changed.queue.items.find((q) => q.id === "gate1:crs-conversion");
    if (!sync) throw new Error("sync PR is in the sweep");
    sync.since = "2026-09-01T00:00:00.000Z";
    const result = todayLines(
      changed,
      items.map((i) => (i.id === sync.id ? { ...i, blockedBy: "stack:lanes" } : i)),
      now,
      context,
    );
    const releaseLine = result.find((line) => line.members.some((m) => m.id === "gate2:legal"));
    const syncLine = result.find((line) => line.members.some((m) => m.id === sync.id));
    expect(releaseLine).not.toBe(syncLine);
    expect(releaseLine).toMatchObject({
      headline: "Integration PR red: its deploy lane failed",
    });
    expect(releaseLine?.members).toHaveLength(5);
    expect(syncLine).toMatchObject({ headline: "Sync PR waits for its deploy lane" });
    expect(syncLine?.members.map((m) => m.id)).toEqual([sync.id]);
  });

  test.each(["release-red:Azure/osdu-spi-entitlements#89", "stack:lanes"])(
    "%s keeps its situation title when no specific headline applies",
    (id) => {
      const previous =
        id === "stack:lanes"
          ? model
          : sweep1116Model({ ...emptyFacts(), ...(sweep1106 as unknown as Partial<Facts>) });
      const item = sweep1116Items(previous).find((i) => i.id === id);
      if (!item) throw new Error(`${id} is in the sweep`);
      const result = todayLines(previous, [item], now, context);
      expect(result).toHaveLength(1);
      expect(result[0]?.headline).toBe(item.title);
    },
  );

  test("different failures stay separate even when both moves are Investigate", () => {
    expect(lineWith("gate2:storage")).toMatchObject({
      subject: "storage",
      headline: "Integration PR fails Validation Summary",
    });
    expect(lineWith("lane-deploy:partition")).toMatchObject({
      subject: "partition",
      headline: "Lane deploy failed",
    });
    expect(lineWith("gate2:storage")).not.toBe(lineWith("lane-deploy:partition"));
  });

  test("a behind integration PR asks for an update before approval", () => {
    const search = items.find((item) => item.id === "gate2:search");
    if (!search) throw new Error("Search's integration PR is missing");
    expect(todayLines(model, [search], now, context)[0]).toMatchObject({
      headline: "Integration PR needs its branch updated, then approval",
      members: [{ id: "gate2:search" }],
    });
  });

  test("approval members do not claim green while a member's checks are running", () => {
    const group = lineWith("gate2:search");
    expect(group?.members.map((m) => m.id)).toEqual(["gate2:search"]);
    expect(group?.subject).toBe("1 fork");
    expect(group?.headline).toBe("Integration PR waits for approval");
    expect(todayInFlight(model, items, now, context)).toContainEqual(
      expect.objectContaining({ member: expect.objectContaining({ id: "gate2:partition" }) }),
    );
  });

  test("no line headline leaks a core verb name or error code", () => {
    const verbs = [...new Set([...Object.values(CLASS_VERB), ...items.map((i) => i.verb)])];
    const changed = structuredClone(model);
    const halt = changed.queue.items.find((q) => q.id === "halt:crs-conversion");
    if (!halt?.halt) throw new Error("halt entries are in the sweep");
    halt.halt.entries.push("UNKNOWN_TOP_LEVEL");
    expect(halt.halt.entries).toContain("UNKNOWN_TOP_LEVEL");
    for (const line of [...lines, ...todayLines(changed, items, now, context)]) {
      for (const verb of verbs) expect(line.headline).not.toContain(verb);
      expect(line.headline).not.toMatch(/\b[A-Z]+(?:_[A-Z]+)+\b/);
    }
  });

  test("undated objects sort last, and a wholly undated line has no age", () => {
    const changed = structuredClone(model);
    const unit = changed.queue.items.find((q) => q.id === "gate1:unit");
    if (!unit) throw new Error("unit PR is in the sweep");
    delete unit.since;
    const result = todayLines(changed, items, now, context);
    const group = result.find((l) => l.members.some((m) => m.id === unit.id));
    expect(group?.members.at(-1)).toMatchObject({ id: unit.id });
    expect(group?.members.at(-1)?.age).toBeUndefined();
    for (const q of changed.queue.items) delete q.since;
    const undated = todayLines(changed, items, now, context);
    expect(
      undated.every((l) => l.age === undefined && l.members.every((m) => m.age === undefined)),
    ).toBe(true);
  });

  test("rollout forks have one honest per-fork classification", () => {
    const rollout = structuredClone(model.rollout);
    if (!rollout) throw new Error("16 Nov has a rollout");
    const base = rollout.forks[0];
    if (!base) throw new Error("The rollout has a fork");
    const fork = (service: string, overrides: Partial<typeof base> = {}) => ({
      ...base,
      service,
      onTarget: false,
      unread: false,
      pr: { number: 1, url: `https://github.com/example/${service}/pull/1`, headSha: "a" },
      validation: { ...base.validation, text: "green", tone: "ok" as const },
      ...overrides,
    });
    const dispatch: typeof base = fork("dispatch");
    delete dispatch.pr;
    const notStarted: typeof base = fork("not-started");
    delete notStarted.pr;
    const cases: (typeof base)[] = [
      fork("merged", { onTarget: true }),
      fork("review"),
      fork("checking", { validation: { ...base.validation, text: "running", tone: "run" } }),
      dispatch,
      notStarted,
      fork("unread", { unread: true }),
      fork("checks-unread", { validation: { ...base.validation, text: "not read", tone: "idle" } }),
      fork("never-read", { unread: true, pr: undefined }),
    ];
    const states = classifyRolloutForks({
      ...rollout,
      forks: cases,
      dispatchNext: [dispatch],
      dispatchWaits: [],
    });
    expect(states.map(({ fork, state }) => [fork.service, state])).toEqual([
      ["merged", "merged"],
      ["review", "to-review"],
      ["checking", "checking"],
      ["dispatch", "to-dispatch"],
      ["not-started", "not-started"],
      ["unread", "to-review"],
      ["checks-unread", "to-review"],
      ["never-read", "not-read"],
    ]);
    const tally = rolloutTally(states);
    expect(tally).toEqual([
      { state: "merged", forks: ["merged"] },
      { state: "to-review", forks: ["review", "unread", "checks-unread"] },
      { state: "checking", forks: ["checking"] },
      { state: "to-dispatch", forks: ["dispatch"] },
      { state: "not-started", forks: ["not-started"] },
      { state: "not-read", forks: ["never-read"] },
    ]);
    expect(tally.flatMap(({ forks }) => forks).sort()).toEqual(
      cases.map(({ service }) => service).sort(),
    );
    expect(rolloutTally(classifyRolloutForks({ ...rollout, forks: [] }))).toEqual([]);
  });

  test("a rollout can owe review and dispatch at once, while checking forks leave Yours", () => {
    const changed = structuredClone(model);
    const rollout = changed.rollout;
    const focus = items.find(({ id }) => id === "rollout");
    if (!rollout || !focus || rollout.forks.length < 3)
      throw new Error("The sweep has a three-fork rollout focus");
    const review = rollout.forks[0];
    const checking = rollout.forks[1];
    const dispatch = rollout.forks[2];
    if (!review || !checking || !dispatch) throw new Error("The rollout has its first three forks");
    for (const fork of rollout.forks) fork.onTarget = true;
    review.onTarget = false;
    review.unread = false;
    review.pr = { number: 1, url: "https://github.com/example/review/pull/1", headSha: "a" };
    review.validation = { ...review.validation, text: "green", tone: "ok" };
    checking.onTarget = false;
    checking.unread = false;
    checking.pr = { number: 2, url: "https://github.com/example/checking/pull/2", headSha: "b" };
    checking.validation = { ...checking.validation, text: "running", tone: "run" };
    dispatch.onTarget = false;
    dispatch.unread = false;
    delete dispatch.pr;
    rollout.dispatchNext = [dispatch];
    rollout.dispatchWaits = [];
    const projected = todayLines(changed, [focus], now, context);
    const counted = todayCounts({ lines: projected });
    expect(projected.find(({ subject }) => subject === "Template")).toMatchObject({
      subject: "Template",
      rollout: { withoutPr: [] },
    });
    expect(
      projected.find(({ members }) => members.some((m) => m.id === `rollout:${review.service}`)),
    ).toMatchObject({ subject: "1 fork" });
    expect(projected.flatMap(({ members }) => members.map(({ id }) => id))).not.toContain(
      `rollout:${checking.service}`,
    );
    expect(counted).toEqual({ total: 2, blocked: 0, waiting: 2 });
    expect(todayInFlight(changed, [focus], now, context)).toEqual([
      expect.objectContaining({
        member: expect.objectContaining({ id: `rollout:${checking.service}` }),
      }),
    ]);
  });

  test.each([
    ["lanes", true],
    ["lane-deploy", true],
    ["main", true],
    ["sync-run", true],
    ["template-run", true],
    ["template-red", true],
    ["release-red", true],
    ["labels", false],
  ] as const)("classifies %s as failing=%s", (kind, expected) => {
    const changed = structuredClone(model);
    const member = structuredClone(lines[0]?.members[0]);
    const queued = structuredClone(changed.queue.items[0]);
    if (!member || !queued) throw new Error("The sweep has a line and a queue item");
    member.id = queued.id;
    member.ids = [queued.id];
    queued.kind = kind;
    changed.queue.items = [queued];
    expect(todayLineFailing(changed, { ...lines[0], members: [member] } as TodayLine)).toBe(
      expected,
    );
  });

  test("a gate fails only when its own PR verdict is red", () => {
    const red = lineWith("gate2:legal");
    if (!red) throw new Error("legal has a red integration PR");
    expect(todayLineFailing(model, red)).toBe(true);
    const pending = todayInFlight(model, items, now, context).find(
      ({ member }) => member.id === "gate2:partition",
    );
    if (!pending) throw new Error("partition has checks running");
    expect(todayLineFailing(model, { ...pending.line, members: [pending.member] })).toBe(false);
  });

  test("orders deadlines, failing, oldest and undated lines independent of input order", () => {
    const row = (
      id: string,
      member: TodayLine["members"][number],
      options: Partial<TodayLine> = {},
    ): TodayLine => ({
      id,
      section: "waiting",
      subject: "subject",
      headline: "headline",
      cause: "",
      effect: "",
      steps: [],
      members: [member],
      ...options,
    });
    const member = (id: string, since?: string) => ({
      id,
      ids: [id],
      fork: id,
      ...(since ? { since, age: "1d" } : {}),
      cause: "",
      effect: "",
      steps: [],
      evidence: { areas: [] as [], attributed: "item" as const, notRead: [] },
    });
    const deadline = (at: string) => ({ at, reason: "due" });
    const input = [
      row("undated", member("undated")),
      row("new", member("new", "2026-11-16T12:00:00.000Z")),
      row("late", member("late"), { deadline: deadline("2026-11-19T00:00:00.000Z") }),
      row("old", member("old", "2026-11-01T00:00:00.000Z")),
      row("failed", { ...member("gate2:legal", "2026-11-15T00:00:00.000Z"), fork: "legal" }),
      row("soon", member("soon"), { deadline: deadline("2026-11-18T00:00:00.000Z") }),
    ];
    const ids = (rows: TodayLine[]) => rows.map(({ id }) => id);
    expect(ids(orderTodayLines(model, input))).toEqual([
      "soon",
      "late",
      "failed",
      "old",
      "new",
      "undated",
    ]);
    expect(ids(orderTodayLines(model, [...input].reverse()))).toEqual(
      ids(orderTodayLines(model, input)),
    );
  });

  test("a member moves only for its own proven rerun, never an unrelated running result", () => {
    const ownItem = items.find(({ id }) => id === "gate1:unit");
    if (!ownItem) throw new Error("unit is in the sweep");
    const own = structuredClone(model);
    const ownQueue = own.queue.items.find(({ id }) => id === ownItem.id);
    if (!ownQueue) throw new Error("unit has a queue item");
    ownQueue.rerun = { state: "in-flight", verdict: "Environment", attempt: 1, later: 2 };
    expect(todayLines(own, [ownItem], now, context)).toEqual([]);
    expect(todayInFlight(own, [ownItem], now, context)).toHaveLength(1);

    const unrelated = structuredClone(model);
    const other = unrelated.queue.items.find(({ id }) => id !== ownItem.id);
    if (!other) throw new Error("The sweep has an unrelated queue item");
    other.rerun = { state: "in-flight", verdict: "Environment", attempt: 1, later: 2 };
    expect(todayLines(unrelated, [ownItem], now, context)).toHaveLength(1);
    expect(todayInFlight(unrelated, [ownItem], now, context)).toEqual([]);
  });

  test("the next actor decides inclusion, Can wait stays out, unknown blockers claim no move", () => {
    const sample = items.find((i) => i.id === "gate1:crs-conversion");
    if (!sample) throw new Error("sample PR is in the sweep");
    expect(todayLines(model, [{ ...sample, actor: "system" }], now, context)).toEqual([]);
    expect(todayLines(model, [{ ...sample, actor: undefined }], now, context)).toEqual([]);
    expect(todayLines(model, [{ ...sample, attention: "background" }], now, context)).toEqual([]);
    expect(todayLines(model, [{ ...sample, blockedBy: "missing" }], now, context)).toEqual([]);
    const blocker = { ...sample, id: "blocker", subject: undefined, actor: "system" as const };
    expect(
      todayLines(model, [blocker, { ...sample, blockedBy: blocker.id }], now, context),
    ).toEqual([]);
    expect(todayLines(model, [{ ...sample, rung: 2 }], now, context)).toHaveLength(1);
    const unknown = todayLines(
      model,
      [{ ...sample, id: "unknown", scope: "unknown" }],
      now,
      context,
    );
    expect(unknown[0]?.members[0]).not.toHaveProperty("home");
    const red = items.find((i) => i.id === "gate2:legal");
    const lanes = items.find((i) => i.id === "stack:lanes");
    if (!red || !lanes) throw new Error("red PR and its lanes blocker are in the sweep");
    const blocked = todayLines(model, [{ ...red, actor: "system" }, lanes], now, context);
    expect(blocked.flatMap((line) => line.members.map((member) => member.id))).toEqual([red.id]);
  });

  test("deadlines name the scheduled reason; conditions never pretend to be a date", () => {
    expect(lineWith("halt:crs-conversion")?.deadline).toMatchObject({
      at: "2026-11-18T00:00:00.000Z",
      reason: expect.stringContaining("Before the next upstream sync"),
    });
    expect(lineWith("rollout")).toMatchObject({
      subject: "Template",
      headline: "Template 1a4730d not synced yet",
      deadline: {
        at: "2026-11-17T08:00:00.000Z",
        reason: expect.stringContaining("all 7 PRs at once"),
      },
    });
  });

  test("rollout counts only behind, read forks with open PRs and keeps a stopped rollout Blocked", () => {
    const facts = { ...emptyFacts(), ...(structuredClone(sweep1106) as unknown as Partial<Facts>) };
    const repo = facts.github.data?.repos["Azure/osdu-spi-partition"];
    const red = repo?.prs.find(({ head }) => head.startsWith("template-sync/"));
    if (!red) throw new Error("6 Nov has a template sync PR for partition");
    red.checks.push({
      id: 999,
      name: "Deploy and Test",
      status: "COMPLETED",
      conclusion: "FAILURE",
    });
    const model = sweep1116Model(facts);
    const items = sweep1116Items(model);
    const rollout = model.rollout;
    const unread = rollout?.forks.find(({ service }) => service === "legal");
    const onTarget = rollout?.forks.find(({ service }) => service === "schema");
    const withoutPr = rollout?.forks.find(({ service }) => service === "file");
    const cut = rollout?.forks.find(({ service }) => service === "storage");
    const cutFacts = cut && facts.github.data?.repos[cut.repo];
    if (!rollout || !unread?.pr || !onTarget?.pr || !withoutPr?.pr || !cut?.pr || !cutFacts)
      throw new Error("6 Nov has open PRs for the rollout cases");
    unread.unread = true;
    onTarget.onTarget = true;
    delete withoutPr.pr;
    delete cut.pr;
    cutFacts.openPrs = cutFacts.prs.length + 1;
    const projected = todayLines(model, items, now, context, { facts });
    const visible = fleetLines(projected, "template");
    const line = visible.find(({ rollout }) => rollout);
    const expected = rollout.forks.filter(
      ({ pr, onTarget }) => pr && pr.url !== red.url && !onTarget,
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(line).toMatchObject({
      section: "waiting",
      subject: `${expected.length} forks`,
      rollout: { withoutPr: ["file"] },
    });
    expect(line?.members.map(({ id, fork, primary }) => [id, fork, primary?.url])).toEqual(
      expected.map(({ service, pr }) => [`rollout:${service}`, service, pr?.url]),
    );
    expect(
      visible
        .flatMap(({ members }) => members)
        .filter(({ primary }) => primary?.url === red.url)
        .map(({ id }) => id),
    ).toEqual(["template-red:partition"]);
    expect(
      todayLines({ ...model, rollout: undefined }, items, now, context).some(({ id }) =>
        id.endsWith(":rollout"),
      ),
    ).toBe(false);
    expect(lineWith("rollout")?.members.map(({ id }) => id)).toEqual(["rollout"]);

    const fixture = watchFixtures().find(({ name }) => name === "snapshot-1106-unverified.json");
    if (!fixture) throw new Error("Missing the unverified watch fixture");
    const { briefing, services } = snapshotAt(fixture.path);
    const yours = todayMembers(briefing);
    expect(yours).toHaveLength(16);
    const blocked = yours.filter(({ line }) => line.section === "blocked");
    expect(blocked).toHaveLength(3);
    const stop = briefing.focus.find(({ id }) => id === "rollout");
    if (!stop) throw new Error("The unverified snapshot has a stopped rollout");
    const entry = blocked.find(({ line }) => line.id === "blocked:rollout");
    expect(entry?.line.members).toHaveLength(1);
    expect(entry?.member).toMatchObject({
      id: "rollout",
      fork: "fleet",
      cause: stop.cause,
      primary: stop.evidence[0],
    });
    expect(yours.some(({ member }) => member.id.startsWith("rollout:"))).toBe(false);
    expect(
      services
        ?.flatMap(({ home }) => home?.overview ?? [])
        .some(({ id }) => id.startsWith("rollout:")),
    ).toBe(false);
  });

  test("adding situation lines leaves the default core briefing byte-identical", () => {
    const brief = () => buildBriefing(model, { state: "clear", problems: [] }, now, context);
    const original = JSON.stringify(brief());
    todayLines(model, items, now, context);
    expect(JSON.stringify(brief())).toBe(original);
    expect(brief()).not.toHaveProperty("lines");
  });
});

test("matrix failures with the same unread check name count one missing read", () => {
  const model = sweep1116Model();
  const pr = model.lines.find(({ fork }) => fork.id === "storage")?.cascadePr;
  const failure = pr?.failures.find(({ cls }) => cls === "UNREAD");
  if (!pr || !failure) throw new Error("Missing unread storage check");
  pr.failures.push({ ...failure });
  expect(itemEvidence(model, ["gate2:storage"]).notRead).toEqual(["Validation Summary job"]);
});
