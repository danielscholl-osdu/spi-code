// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { ActionItem } from "../../src/act/action-item.js";
import { bindingSchema } from "../../src/act/verbs.js";
import { createContext } from "../../src/context.js";
import {
  approvalSection,
  createInspectRegistry,
  type InspectOptions,
  rolloutActionItems,
  verbsOf,
} from "../../src/inspect/actions.js";
import { inspectStep, ladderSection, STEP_PREFIX, stepTitle } from "../../src/inspect/step.js";
import type { FailureClass } from "../../src/model/attribution.js";
import { buildModel } from "../../src/model/index.js";
import type { QueueItem } from "../../src/model/queue.js";
import { fixtureContext } from "../briefing-setup.js";
import { FIXTURE_NOW, fixtureFacts, laneFacts } from "../harness.js";

const context = createContext({ ...fixtureContext, clock: { now: () => FIXTURE_NOW } });
const model = buildModel(fixtureFacts(), FIXTURE_NOW, {}, context);
interface Section {
  kind: string;
  title?: string;
  items: { actions?: ActionItem[]; action?: { payload: { id: string } }; [key: string]: unknown }[];
}
function oracle<T>(name: string): T {
  return JSON.parse(
    readFileSync(
      new URL(`../../../../fixtures/rib-59d6895/oracle/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
}
const extra = oracle<{
  cases: {
    name: string;
    fixture: "fixture" | "lanes" | "down";
    item: QueueItem;
    opts: InspectOptions;
    actions: ActionItem[];
    approvals?: Section;
  }[];
  ladder: Section;
  shaLadder: Section;
  steps: {
    id: string;
    board: {
      header: { status: { label: string; tone: string }; chip?: string };
      sections: Section[];
    };
  }[];
}>("inspect-actions");
const models = {
  fixture: model,
  lanes: buildModel(laneFacts(), FIXTURE_NOW, {}, context),
  down: buildModel(laneFacts(true), FIXTURE_NOW, {}, context),
};
const overrides: Record<FailureClass, Partial<QueueItem>> = {
  ENV: { kind: "lanes" },
  ACCESS: {
    kind: "access",
    cause: [
      { label: "reason", value: 'denied: "ghcr.io/azure/osdu-spi-legal:pr-9" requires auth' },
    ],
  },
  TEST: { kind: "template-red", cause: [{ label: "reason", value: "failed suites: acceptance" }] },
  HALT: {
    kind: "halt",
    rung: 0,
    halt: { fork: "entitlements", code: "UNKNOWN_TOP_LEVEL", entries: ["schemathesis-tests"] },
  },
  TOOLCHAIN: {
    cause: [
      {
        label: "reason",
        value: "RequireJavaVersion: JDK 17.0.20-1 is outside the allowed range [25,)",
      },
    ],
  },
  CONFLICT: { kind: "conflict", rung: 0 },
  POLICY: {},
  INFRA: {},
  BUILD: { kind: "release-red", cause: [{ label: "check", value: "Java Build › Run Java Build" }] },
  UNREAD: {},
};

describe("rib inspector action parity before app policy", () => {
  test.each(Object.keys(overrides) as FailureClass[])(
    "%s offers the frozen oracle actions",
    (cls) => {
      const item: QueueItem = {
        id: "x",
        kind: "gate1",
        rung: 1,
        scope: "svc",
        text: "",
        effects: [],
        cause: [],
        incident: true,
        blocks: 1,
        cls,
        ...overrides[cls],
      };
      const board = oracle<{ sections: Section[] }>(`inspect/${cls}`);
      const next = board.sections.find((s) => s.title === "Next step");
      expect(next).toBeDefined();
      expect(verbsOf(item, model, context)).toEqual(next?.items[0]?.actions ?? []);
    },
  );

  test.each(extra.cases)(
    "$name matches labels, eligibility, reasons, confirmations and bindings",
    (c) => {
      const m = models[c.fixture];
      expect(verbsOf(c.item, m, context, c.opts)).toEqual(c.actions);
      const { kind: _kind, ...section } = c.approvals ?? { kind: "" };
      expect(approvalSection(c.item, m, c.opts)).toEqual(c.approvals ? section : undefined);
    },
  );

  test("a missing sweep blocks lane, lifecycle, template and approval actions", () => {
    for (const c of extra.cases.filter((c) =>
      ["deployable lanes", "failed lifecycle", "template actions", "approval waiting"].includes(
        c.name,
      ),
    )) {
      const m = { ...models[c.fixture], sweptAt: undefined };
      const actions = [
        ...verbsOf(c.item, m, context, c.opts),
        ...(approvalSection(c.item, m, c.opts)?.items.flatMap((i) => i.actions) ?? []),
      ];
      expect(actions.length).toBeGreaterThan(0);
      for (const action of actions) {
        expect(action).toMatchObject({ disabled: true, reason: "no sweep has read GitHub yet" });
        expect(action.confirm).toBeUndefined();
      }
    }
  });

  test.each([
    { count: 2, cap: null, names: true, waiting: 0 },
    { count: 4, cap: null, names: false, waiting: 0 },
    { count: 5, cap: 2, names: true, waiting: 3 },
  ])(
    "sync label names at most three targets and retains pacing ($count forks, cap $cap)",
    ({ count, cap, names, waiting }) => {
      const rows = model.template.rows.slice(0, count).map((row) => ({
        ...row,
        pr: undefined,
        behind: 1,
        syncing: undefined,
        dispatched: undefined,
      }));
      const m = { ...model, template: { ...model.template, rows }, lanes: { cap, inflight: [] } };
      const eligible = rows.slice(0, cap ?? count);
      const label = `Sync all forks · ${names ? eligible.map((r) => r.service).join(", ") : count}${waiting ? ` · ${waiting} wait` : ""}`;
      const [sync] = rolloutActionItems(m, context);
      expect(sync?.label).toBe(label);
      expect(sync?.confirm?.confirmLabel).toBe(label);
      expect(bindingSchema.parse(sync?.binding).targets.map((t) => t.label)).toEqual(
        eligible.map((r) => r.service),
      );
      const [blocked] = rolloutActionItems(m, context, "blocked by caller");
      expect(blocked).toMatchObject({ label, disabled: true, reason: "blocked by caller" });
      expect(blocked?.confirm).toBeUndefined();
    },
  );

  test("each registry independently holds every executable rib verb", () => {
    const ids = [
      "approve-runs",
      "rerun",
      "dispatch-env-refresh",
      "dispatch-env-upgrade",
      "sync-template",
      "roll-out",
      "sync-upstream",
      "start-upstream",
      "dispatch-cascade",
      "rerun-cascade",
      "fleet-release",
    ];
    const first = createInspectRegistry();
    const second = createInspectRegistry();
    for (const id of ids) {
      expect(first.verbOf(id)?.id).toBe(id);
      expect(second.verbOf(id)?.id).toBe(id);
    }
    for (const c of extra.cases) {
      for (const action of [
        ...c.actions,
        ...(c.approvals?.items.flatMap((i) => i.actions ?? []) ?? []),
      ]) {
        const binding = bindingSchema.parse(action.binding);
        expect(first.verbOf(binding.verb)).toBeDefined();
      }
    }
    first.registerVerb({ id: "isolated", label: "Isolated", command: () => [] });
    expect(second.verbOf("isolated")).toBeUndefined();
  });
});

describe("template ladder and step data", () => {
  test.each([false, true])(
    "ladder labels, spread, navigation and summaries match rib (bySha=%s)",
    (bySha) => {
      const expected = bySha ? extra.shaLadder : extra.ladder;
      expect(ladderSection(model, bySha)).toEqual({
        title: expected.title,
        items: expected.items.map(({ action, ...row }) => ({
          ...row,
          inspect: action?.payload.id,
        })),
      });
    },
  );

  test.each(extra.steps)(
    "$id retains the step status, changes, fork order and evidence",
    ({ id, board }) => {
      const result = inspectStep(model, id, context);
      const summary = board.sections[0]?.items[0]?.text;
      const changes = board.sections.find((s) => s.title?.startsWith("Changes"));
      const forks = board.sections.find((s) => s.title === "Forks");
      const evidence = board.sections.find((s) => s.title === "Evidence");
      expect(result).toEqual({
        status: board.header.status,
        ...(board.header.chip ? { chip: board.header.chip } : {}),
        summary,
        changes: changes?.items ?? [],
        forks: forks?.items ?? [],
        evidence: evidence?.items.map(({ text, href }) => ({ text, href })) ?? [],
      });
      const step = model.template.steps.find((s) => `${STEP_PREFIX}${s.marker}` === id);
      expect(stepTitle(model, id)).toBe(step ? `osdu-spi · ${step.label}` : undefined);
    },
  );

  test("an empty ladder has no section and a moved selection stays explicit", () => {
    const empty = { ...model, template: { ...model.template, steps: [] } };
    expect(ladderSection(empty)).toBeUndefined();
    expect(inspectStep(empty, "step:gone", context).status.label).toBe("MOVED");
  });
});
