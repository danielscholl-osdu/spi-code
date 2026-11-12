// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { moving } from "../views/today/in-motion.test-helper.js";
import { treeServices } from "./queue.js";
import {
  AT_PLACE,
  briefingItems,
  coverage,
  EXEMPTIONS,
  HOLD_GAP,
  leaves,
  motionCases,
  openerCases,
  type Reach,
  STARTS,
  uncoveredRoutes,
} from "./reachability.test-helper.js";
import {
  answerDetail,
  assertReach,
  bad,
  busySnapshot,
  calmSnapshot,
  cases,
  click,
  container,
  drawn,
  fixture,
  ITEM_HOME,
  ITEM_MORNINGS,
  inMotion,
  inside,
  itemHomeCases,
  missingHomes,
  openHome,
  pairs,
  shellHooks,
  start,
} from "./reachability-shell.test-helper.js";
import { DEFAULT_REGISTRY } from "./routes.js";

shellHooks((path) => readFileSync(path, "utf8"));

describe("every Briefing and Releases field the 6 Nov sweep carries", () => {
  it("has a case or a named exemption for every leaf, and every exemption still applies", () => {
    expect(coverage(fixture(), cases)).toEqual({
      uncovered: [],
      stray: [],
      drawn: [],
      stale: [],
      partial: [],
    });
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
      const shape = JSON.stringify([home.start, String(home.step), home.detail?.id]);
      expect(byName.get(home.name) ?? shape, home.name).toBe(shape);
      byName.set(home.name, shape);
    }
  });

  it("has a case or a named exemption for every route, the sheet and the strip", () => {
    expect(uncoveredRoutes(DEFAULT_REGISTRY, cases)).toEqual([]);
  });

  it("has shared fields to compare", () => {
    expect(pairs.size).toBeGreaterThan(0);
  });
});

describe("In motion and Can wait, on mornings that carry them", () => {
  const MORNINGS = {
    calm: () => structuredClone(calmSnapshot),
    "busy with motion": () => moving(structuredClone(busySnapshot)),
  };
  it.each(Object.entries(MORNINGS))(
    "has a case for every In progress and Can wait leaf on the %s morning, each within one click",
    async (_name, morning) => {
      const body = morning();
      const motion = motionCases(body);
      const pointers = new Set(motion.map(({ pointer }) => pointer));
      const mine = leaves(body)
        .map(({ pointer }) => pointer)
        .filter((pointer) => /^\/briefing\/(ambient\/inProgress|canWait)\//.test(pointer));
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.filter((pointer) => !pointers.has(pointer))).toEqual([]);
      const reached = [...new Map(motion.map(({ home }) => [home.name, home])).values()];
      for (const home of reached) {
        await openHome(home, body);
        for (const row of motion.filter((row) => row.home.name === home.name)) assertReach(row);
      }
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

  it("builds its In motion morning the way core would", () => {
    const { briefing } = inMotion();
    const items = new Map(briefingItems(briefing).map(([, item]) => [item.id, item]));
    const elsewhere = new Set([
      ...(briefing.horizon.cards ?? []).flatMap(({ itemIds }) => itemIds),
      ...(briefing.horizon.owed?.itemIds ?? []),
      ...(briefing.decisions?.groups ?? []).flatMap(({ itemIds }) => itemIds),
      ...(briefing.ambient?.failing?.lines ?? []).flatMap(({ itemIds }) => itemIds),
    ]);
    const lines = briefing.ambient?.inProgress?.lines ?? [];
    expect(lines.length).toBeGreaterThan(0);
    for (const id of lines.flatMap(({ itemIds }) => itemIds)) {
      expect(items.get(id)?.attention, id).toBe("ambient");
      expect(elsewhere.has(id), id).toBe(false);
    }
  });

  it("fails when an item drawn in two homes loses either home's cases, or all of them", () => {
    const body = bad();
    const [legal] = briefingItems(body.briefing).find(([, { id }]) => id === "gate1:legal") ?? [];
    expect(legal).toBeDefined();
    const card = '.today-band li.today-need[data-item-id="gate1:legal"]';
    const sync = '.today-horizon .horizon-card[data-card-id="sync:gate1:legal"]';
    const rows = itemHomeCases(body);
    const mine = (row: Reach) => row.pointer.startsWith(`${legal}/`);
    const without = (container: string) =>
      rows.filter((row) => !(mine(row) && inside(row, container)));
    expect(rows.filter((row) => mine(row) && inside(row, card)).length).toBeGreaterThan(0);
    expect(rows.filter((row) => mine(row) && inside(row, sync)).length).toBeGreaterThan(0);
    expect(missingHomes(body, without(card))).toEqual([`gate1:legal at ${card}`]);
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

describe("the suite's own guards", () => {
  it("reports a leaf no surface draws", () => {
    const body = fixture();
    (body.briefing as unknown as Record<string, unknown>).added = "a field no surface draws";
    expect(coverage(body, cases).uncovered).toEqual(["/briefing/added"]);
  });

  it("reports an exemption pattern no leaf uses", () => {
    const unused = { ...EXEMPTIONS, unused: { patterns: ["/nowhere"], reason: "test" } };
    expect(coverage(fixture(), cases, unused).stale).toEqual(["unused /nowhere"]);
  });

  it("keeps a pending contract field out of stale until core fills it, and exempts it once it does", () => {
    const later = { patterns: ["/briefing/later"], reason: "test", pending: true as const };
    const exemptions = { ...EXEMPTIONS, later };
    expect(coverage(fixture(), cases, exemptions).stale).toEqual([]);
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
    const target = { detail: "same-target" };
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
    const hold = cases.find(({ exempt }) => exempt === HOLD_GAP)?.home;
    expect(hold?.step).toBeDefined();
    if (!hold) return;
    await expect(openHome(hold)).rejects.toThrow(/click/);
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

describe("named gaps the suite tracks until their beads close", () => {
  it("spicode-t1k.226: a hold's Detail draws the host's answer two clicks from Environment, not one", async () => {
    const rows = cases.filter(({ exempt }) => exempt === HOLD_GAP);
    const hold = rows[0]?.home;
    expect(hold?.step).toBeDefined();
    expect(rows.some(({ selector }) => String(selector).includes("inspector-related"))).toBe(true);
    if (!hold?.step) return;
    // The Detail reads its times against the wall clock; pin it to the track's clock the expected
    // text reads against, so the day prefix agrees in every zone.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse(fixture().briefing.environment.to) });
    await start(hold);
    expect(await click('[data-part="runs"] > summary', hold.name)).toBe(1);
    expect(container.querySelector(".inspector")).toBeNull();
    expect(await click(hold.step, hold.name)).toBe(1);
    await answerDetail(hold);
    for (const row of rows) assertReach(row);
  });
});
