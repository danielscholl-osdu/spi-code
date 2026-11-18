// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { describe, expect, it } from "vitest";
import { readFixture } from "../../../../scripts/watch-generated.mjs";
import { directoryPaths } from "../test-utils/directory-paths.test.js";
import { fixtureLoader } from "../test-utils/harness.js";
import snapshot1116 from "../views/today/snapshot-1116.json?raw";
import type { Route } from "./navigation.js";
import { treeServices } from "./queue.js";
import {
  AT_PLACE,
  briefingItems,
  coverage,
  EXEMPTIONS,
  leaves,
  lowerCases,
  memberRow,
  openerCases,
  type Reach,
  STARTS,
  uncoveredRoutes,
} from "./reachability.test-helper.js";
import {
  assertOpens,
  assertReach,
  bad,
  busySnapshot,
  calmSnapshot,
  cases,
  container,
  DEALS,
  dealProblems,
  drawn,
  fixture,
  ITEM_HOME,
  ITEM_MORNINGS,
  inside,
  itemHomeCases,
  missingHomes,
  openHome,
  pairs,
  shellHooks,
  start,
} from "./reachability-shell.test-helper.js";
import { DEFAULT_REGISTRY } from "./routes.js";

shellHooks(readFixture);

/** The recorded 59d6895 sweep with an origin on a since slot: the optional leaves the 6 Nov sweep lacks. */
const optionalSince = () =>
  fixtureLoader((path) => {
    const body = JSON.parse(readFixture(path));
    body.briefing.since.rows[0].slots[0].origin = "upstream";
    return JSON.stringify(body);
  })("snapshot-59d6895.json");

/** Exemption patterns no leaf uses on the 6 Nov sweep nor on the optional-field one. */
function staleOnEvery(exemptions = EXEMPTIONS) {
  const [first = [], ...rest] = [fixture(), optionalSince()].map(
    (body) => coverage(body, cases, exemptions).stale,
  );
  return first.filter((entry) => rest.every((stale) => stale.includes(entry)));
}

describe("every Briefing and Releases field the 6 Nov sweep carries", () => {
  it("has a case or a named exemption for every leaf, and every exemption still applies", () => {
    expect({ ...coverage(fixture(), cases), stale: staleOnEvery() }).toEqual({
      uncovered: [],
      stray: [],
      drawn: [],
      stale: [],
      partial: [],
    });
  });

  it("counts an exemption used when the optional-field sweep uses it", () => {
    const optional = [
      "since-undrawn /briefing/since/asOf",
      "since-undrawn /briefing/since/rows/#/slots/#/origin",
    ];
    expect(coverage(fixture(), cases).stale).toEqual(optional);
    const used = coverage(optionalSince(), cases).stale;
    expect(optional.filter((entry) => used.includes(entry))).toEqual([]);
  });

  it("starts every home at a signed-off place, and one name means one home", () => {
    const body = fixture();
    const starts = [
      ...Object.values(STARTS).filter((entry) => typeof entry !== "function"),
      ...treeServices(body.tree).map(STARTS.service),
      ...body.releases.lines.map(({ month }) => STARTS.release(month)),
    ];
    const byName = new Map<string, string>();
    for (const { home } of cases) {
      expect(starts, home.name).toContainEqual(home.start);
      const shape = JSON.stringify([home.start, String(home.step)]);
      expect(byName.get(home.name) ?? shape, home.name).toBe(shape);
      byName.set(home.name, shape);
    }
  });

  it("has a case or a named exemption for every route and the strip", () => {
    expect(uncoveredRoutes(DEFAULT_REGISTRY, cases)).toEqual([]);
  });

  it("exempts briefing.since and the verdict by name, with or without lines", () => {
    const verdict = ["/briefing/verdict/text", "/briefing/verdict/mark"];
    expect(EXEMPTIONS["since-undrawn"]?.reason).toMatch(/^spicode-f0s\.47: /);
    for (const body of [fixture(), optionalSince()]) {
      const uncovered = coverage(body, []).uncovered;
      expect(uncovered.filter((pointer) => pointer.startsWith("/briefing/since/"))).toEqual([]);
    }
    const older = structuredClone(calmSnapshot);
    delete older.briefing.lines;
    for (const body of [fixture(), older])
      expect(coverage(body, []).uncovered.filter((pointer) => verdict.includes(pointer))).toEqual(
        [],
      );
    expect(cases.filter(({ pointer }) => verdict.includes(pointer))).toEqual([]);
  });

  it("has shared fields to compare", () => {
    expect(pairs.size).toBeGreaterThan(0);
  });
});

describe("the fleet flow, Can wait, Moving without you and Last 24 hours, on every morning", () => {
  const MORNINGS = {
    "6 Nov": fixture,
    calm: () => structuredClone(calmSnapshot),
    busy: () => structuredClone(busySnapshot),
  };
  it.each(Object.entries(MORNINGS))(
    "has a case or a named exemption for every summary leaf on the %s morning, each within one click",
    async (_name, morning) => {
      const body = morning();
      const lower = lowerCases(body);
      const mine = leaves(body)
        .map(({ pointer }) => pointer)
        .filter((pointer) => pointer.startsWith("/briefing/today/"));
      expect(mine.length).toBeGreaterThan(0);
      expect(coverage(body, lower).uncovered.filter((pointer) => mine.includes(pointer))).toEqual(
        [],
      );
      const homes = new Map(lower.map(({ home }) => [home.name, home]));
      for (const [name, home] of homes) {
        await openHome(home, body);
        for (const row of lower.filter((row) => row.home.name === name)) assertReach(row);
      }
      for (const { rows } of openerCases(lower.filter(({ opens }) => opens)))
        await assertOpens(rows, body);
    },
  );
});

describe("every focus and rest item's scope and origin, at its home on Today", () => {
  it("registers each of the four scope and origin patterns on these mornings", () => {
    const pointers = Object.values(ITEM_MORNINGS).flatMap((morning) =>
      itemHomeCases(morning()).map(({ pointer }) => pointer.replace(/\/\d+\//, "/#/")),
    );
    expect(new Set(pointers)).toEqual(
      new Set(
        ["focus", "rest"].flatMap((list) => [
          `/briefing/${list}/#/scope`,
          `/briefing/${list}/#/origin`,
        ]),
      ),
    );
  });

  it("fails when an item's home on Today loses its cases", () => {
    const body = bad();
    const [legal] = briefingItems(body.briefing).find(([, { id }]) => id === "gate1:legal") ?? [];
    expect(legal).toBeDefined();
    const index = (body.briefing.lines ?? []).findIndex(({ members }) =>
      members.some(({ id }) => id === "gate1:legal"),
    );
    const line = body.briefing.lines?.[index];
    const at = line?.members.findIndex(({ id }) => id === "gate1:legal") ?? -1;
    expect(at).toBeGreaterThanOrEqual(0);
    const sync = memberRow(`/briefing/lines/${index}`, at, line?.members.length === 1);
    const rows = itemHomeCases(body);
    const mine = (row: Reach) => row.pointer.startsWith(`${legal}/`);
    const without = (container: string) =>
      rows.filter((row) => !(mine(row) && inside(row, container)));
    expect(rows.filter((row) => mine(row) && inside(row, sync)).length).toBeGreaterThan(0);
    expect(missingHomes(body, without(sync))).toEqual([`gate1:legal at ${sync}`]);
    const { uncovered } = coverage(
      body,
      rows.filter((row) => !mine(row)),
      { ...EXEMPTIONS, ...AT_PLACE },
    );
    expect(uncovered.filter((pointer) => ITEM_HOME.test(pointer)).sort()).toEqual([
      `${legal}/origin`,
      `${legal}/scope`,
    ]);
  });
});

/** The items Horizon, the place cards and In motion held, before Today dropped them. */
function carriedByRemovedBlocks({ briefing }: ViewSnapshot) {
  const { horizon, places, ambient, canWait } = briefing;
  return new Set([
    ...(horizon.cards ?? []).flatMap(({ itemIds }) => itemIds),
    ...(horizon.owed?.itemIds ?? []),
    ...(places ?? []).flatMap(({ itemIds, fresh }) => [...itemIds, ...fresh.itemIds]),
    ...[...(ambient?.failing.lines ?? []), ...(ambient?.inProgress.lines ?? [])].flatMap(
      ({ itemIds }) => itemIds,
    ),
    ...(canWait?.items ?? []).flatMap(({ itemIds }) => itemIds),
  ]);
}

const READING_ROUTES: Readonly<Record<string, (id?: string) => Route>> = {
  upstream: () => ({ kind: "upstream" }),
  environment: () => ({ kind: "environment" }),
  engineering: () => ({ kind: "engineering-system" }),
  security: () => ({ kind: "security" }),
  service: (id = "") => ({ kind: "service", id }),
};

describe("every item a removed Today block carried keeps one home on Today or its place (PS-19)", () => {
  const MORNINGS = {
    "16 Nov": () => ViewSnapshotSchema.parse(JSON.parse(snapshot1116)),
    "6 Nov": fixture,
    calm: () => structuredClone(calmSnapshot),
    busy: () => structuredClone(busySnapshot),
    bad,
    "59d6895": () => fixtureLoader(readFixture)("snapshot-59d6895.json"),
  };
  it.each(Object.entries(MORNINGS))("on the %s morning", async (name, morning) => {
    const body = morning();
    const carried = carriedByRemovedBlocks(body);
    expect(carried.size, name).toBeGreaterThan(0);
    const lines = body.briefing.lines ?? [];
    const onToday = new Map(
      lines.flatMap((line, index) =>
        line.members.flatMap((member, at) =>
          [...new Set([member.id, ...member.ids])].map(
            (id) =>
              [id, memberRow(`/briefing/lines/${index}`, at, line.members.length === 1)] as const,
          ),
        ),
      ),
    );
    await start({ name: "Today", start: STARTS.today }, body);
    const objectRows = new Map<string, string[]>();
    for (const [index, line] of lines.entries()) {
      for (const [at, member] of line.members.entries()) {
        const rows = objectRows.get(member.id) ?? [];
        rows.push(memberRow(`/briefing/lines/${index}`, at, line.members.length === 1));
        objectRows.set(member.id, rows);
      }
    }
    for (const [id, rows] of objectRows)
      expect(container.querySelectorAll(rows.join(",")), `${name}: one row for ${id}`).toHaveLength(
        1,
      );
    const homeless: string[] = [];
    for (const id of carried) {
      const row = onToday.get(id);
      if (row) {
        expect(container.querySelectorAll(row), `${name}: ${id}`).toHaveLength(1);
        continue;
      }
      const places = body.readings.flatMap(({ anchor, content }) => {
        const route = READING_ROUTES[anchor.kind];
        return route && content?.items.some((item) => item.id === id)
          ? [route("id" in anchor ? anchor.id : undefined)]
          : [];
      });
      let listed = false;
      for (const route of places) {
        await start(
          { name: route.kind, start: { name: route.kind, surface: route.kind, route } },
          body,
        );
        const at = JSON.stringify(id);
        listed ||= !!container.querySelector(
          `main [data-item-id=${at}], main [data-selection-id=${at}]`,
        );
      }
      if (!listed) homeless.push(id);
      await start({ name: "Today", start: STARTS.today }, body);
    }
    expect(homeless, name).toEqual([]);
  });
});

describe("the suite's own guards", () => {
  const sources = Object.fromEntries(
    directoryPaths("apps/window/src/app")
      .filter((file) => !file.includes("/") && file.endsWith(".test.tsx"))
      .map((file) => [file, readFileSync(`apps/window/src/app/${file}`, "utf8")]),
  );

  it("runs every dealt fields and item-homes part exactly once, in its own file", () => {
    expect(DEALS).toBe(3);
    expect(dealProblems(sources)).toEqual([]);
  });

  it("reports a deleted, repeated or misdealt fields or item-homes part", () => {
    const fields = "sweepFields";
    const {
      "reachability.item-homes-1.test.tsx": _deleted,
      "reachability.fields-3.test.tsx": _missing,
      ...rest
    } = sources;
    expect(
      dealProblems({
        ...rest,
        "reachability.fields-3.test.tsx": `${fields}(dealt(1, 3), readFixture);`,
        "reachability.test.tsx": `${fields}(dealt(0, 2), readFixture);`,
      }),
    ).toEqual([
      `reachability.test.tsx: ${fields}(dealt(0, 2) is not dealt as one of 3 parts`,
      "sweepFields part 1 runs in [reachability.fields-2.test.tsx, reachability.fields-3.test.tsx], not reachability.fields-2.test.tsx",
      "sweepFields part 2 runs in [], not reachability.fields-3.test.tsx",
      "reachability.item-homes-1.test.tsx is missing",
      "itemHomesOn part 0 runs in [], not reachability.item-homes-1.test.tsx",
    ]);
  });

  it("reports a leaf no surface draws", () => {
    const body = fixture();
    (body.briefing as unknown as Record<string, unknown>).added = "a field no surface draws";
    expect(coverage(body, cases).uncovered).toEqual(["/briefing/added"]);
  });

  it("reports an exemption pattern no leaf uses", () => {
    const unused = { ...EXEMPTIONS, unused: { patterns: ["/nowhere"], reason: "test" } };
    expect(staleOnEvery(unused)).toEqual(["unused /nowhere"]);
  });

  it("keeps a pending contract field out of stale until core fills it, and exempts it once it does", () => {
    const later = { patterns: ["/briefing/later"], reason: "test", pending: true as const };
    const exemptions = { ...EXEMPTIONS, later };
    expect(staleOnEvery(exemptions)).toEqual([]);
    const body = fixture();
    (body.briefing as unknown as Record<string, unknown>).later = "a field core fills later";
    expect(coverage(body, cases, exemptions).uncovered).toEqual([]);
  });

  it("reports a pending or never-drawn exemption on a leaf a case draws", () => {
    const leaf = "/releases/today/platform/stack";
    expect(drawn.some(({ pointer }) => pointer === leaf)).toBe(true);
    const reasons = { reason: "test", patterns: [leaf] };
    for (const exemption of [{ ...reasons, pending: true as const }, reasons])
      expect(coverage(fixture(), cases, { ...EXEMPTIONS, later: exemption }).drawn).toEqual([
        `later ${leaf}`,
      ]);
  });

  it("groups openers by the click itself, so two function selectors to one target both click", () => {
    const [row] = drawn;
    expect(row).toBeDefined();
    if (!row) return;
    const target = { opened: ".same-target" };
    const first = (root: ParentNode) => root.querySelector(".first");
    const second = (root: ParentNode) => root.querySelector(".second");
    const groups = openerCases([
      { ...row, pointer: "/a", opens: { click: first, ...target } },
      { ...row, pointer: "/b", opens: { click: second, ...target } },
      { ...row, pointer: "/c", opens: { click: first, ...target } },
    ]);
    expect(groups.map(({ rows }) => rows.map(({ pointer }) => pointer))).toEqual([
      ["/a", "/c"],
      ["/b"],
    ]);
  });

  it("exempts only the exact leaf patterns it names, never a same-named leaf elsewhere", () => {
    const body = fixture();
    Object.assign(body.briefing.flow, {
      evidence: [{ label: "a new label", url: "https://example.com" }],
      id: "a new id",
    });
    expect(coverage(body, cases).uncovered).toEqual([
      "/briefing/flow/evidence/0/label",
      "/briefing/flow/evidence/0/url",
      "/briefing/flow/id",
    ]);
  });

  it("reports a partial case whose shown prefix and missing tail do not make up its leaf", () => {
    const misfit = cases.map((row) =>
      row.partial ? { ...row, partial: { ...row.partial, tail: "not the tail" } } : row,
    );
    expect(coverage(fixture(), misfit).partial.every((entry) => "misfit" in entry)).toBe(true);
  });

  it("rejects a click on a target hidden inside a closed details", async () => {
    const step = '[data-part="repository"] button.env-repo-line';
    const hidden = { name: "Environment · Stack repository line", start: STARTS.environment, step };
    await start(hidden);
    expect(container.querySelector(step)?.closest("details")?.open).toBe(false);
    await expect(openHome(hidden)).rejects.toThrow(/click/);
  });

  it("reports a route with no case", () => {
    const registry = {
      ...DEFAULT_REGISTRY,
      views: { ...DEFAULT_REGISTRY.views, added: () => null },
    };
    expect(uncoveredRoutes(registry, cases)).toEqual(["added"]);
  });

  it("fails a field whose value no surface shows", async () => {
    const row = drawn.find(({ pointer }) => pointer === "/briefing/environment/headline");
    expect(row).toBeDefined();
    if (!row) return;
    const body = fixture();
    body.briefing.environment.headline = "";
    await openHome(row.home, body);
    expect(() => assertReach(row)).toThrow();
  });
});
