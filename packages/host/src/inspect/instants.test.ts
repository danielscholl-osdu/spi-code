// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { InspectResult } from "@spi-code/contracts";
import {
  type ActionItem,
  type Exec,
  forkActions,
  mrTitle,
  planActions,
  REPO_PREFIX,
  rolloutActions,
  STEP_PREFIX,
  UPSTREAM_ITEM,
  UPSTREAM_PREFIX,
  type UpstreamActions,
  verbsOf,
} from "@spi-code/core";
import { describe, expect, it } from "vitest";
import { briefingHolds } from "../../test/watch/detail-feed.js";
import { appStyle, recordedInput } from "../../test/watch/snapshot-fixture.js";
import { projectWatch } from "../watch/project.js";
import { recordedRuns } from "../watch/recorded-runs.js";
import { holdResult } from "./hold.js";
import { RUN_PREFIX, STATION_PREFIX } from "./prefixes.js";
import { inspectScope, resolveIn } from "./resolve.js";

const offline: Exec = {
  runJSON: async () => ({ ok: false, error: "offline", code: 1 }),
  runText: async () => ({ ok: false, error: "offline", code: 1 }),
};
const input = appStyle(recordedInput());
const ctx = input.context;
const view = projectWatch(input);
const scope = inspectScope(
  { view, facts: input.facts, releases: { ...input.releases, records: input.releaseRecords } },
  { ctx, exec: offline, appData: input.appData },
);
const { model, now } = scope;
const swept = model.sweptAt ?? "";

const iso = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})\b/g;

function noClocks(value: unknown) {
  const text = JSON.stringify(value).replace(iso, "instant");
  expect(text).not.toMatch(/\b\d{2}:\d{2}\b/);
  expect(text).not.toMatch(/Invalid Date|undefined|1970-01-01|NaN/);
}

const instantsIn = (value: unknown) => JSON.stringify(value).match(iso)?.length ?? 0;

/** What Detail draws and Ask attaches; areas carry only the sweep's own observedAt. */
const shown = ({ areas: _a, provenance: _p, ...rest }: InspectResult) => rest;

const briefRead = ({ cause, effect, next }: InspectResult) => ({ cause, effect, next });
const ownText = (result: InspectResult) => ({
  ...shown(result),
  ...(KINDS["queue item"]?.includes(result.id) ? { cause: "", effect: "", next: "" } : {}),
});

const KINDS: Record<string, readonly string[]> = {
  "queue item": model.queue.items.map(({ id }) => id),
  station: model.lines.flatMap((line) =>
    line.stations.map((s) => `${STATION_PREFIX}${line.fork.id}:${s.id}`),
  ),
  repository: model.repositories.rows.map((r) => `${REPO_PREFIX}${r.name}`),
  "template step": model.template.steps.map((s) => `${STEP_PREFIX}${s.marker}`),
  MR: Object.entries(model.radar.services)
    .flatMap(([name, service]) => service.possible.map((v) => `mr:${name}:${v.mr?.iid}`))
    .filter((id) => mrTitle(model, id)),
  "upstream plan": [UPSTREAM_ITEM],
  "upstream fork": model.upstream.forks.map((f) => `${UPSTREAM_PREFIX}${f.service}`),
  hold: briefingHolds(view.briefing).map(({ id }) => id),
  run: recordedRuns(input.facts, ctx.stackRepo).map(({ run }) => `${RUN_PREFIX}${run.id}`),
};

/** Kinds whose 6 Nov results name a time, so the rule is not passed by saying none. */
const TIMED = [
  "queue item",
  "station",
  "repository",
  "template step",
  "MR",
  "upstream plan",
  "hold",
];

describe("inspect results on the 6 Nov input, in the app's time style", () => {
  it.each(Object.entries(KINDS))("keeps every %s time as an ISO instant", async (kind, ids) => {
    expect(ids.length, kind).toBeGreaterThan(0);
    const results = await Promise.all(ids.map((id) => resolveIn(scope, id)));
    const found = results.filter((r): r is InspectResult => r !== undefined);
    expect(found.map(({ id }) => id)).toEqual(ids);
    if (TIMED.includes(kind)) expect(instantsIn(found.map(ownText)), kind).toBeGreaterThan(0);
    noClocks(found.map(ownText));
  });

  it("keeps the briefing's reading of every queue item as instants", async () => {
    const items = await Promise.all((KINDS["queue item"] ?? []).map((id) => resolveIn(scope, id)));
    const read = items.flatMap((r) => (r ? [briefRead(r)] : []));
    expect(instantsIn(read)).toBeGreaterThan(0);
    noClocks(read);
  });
});

describe("a hold whose ends cannot all be read", () => {
  const recorded = briefingHolds(view.briefing)[0]?.event;
  if (!recorded) throw new Error("the 6 Nov sweep has a hold");
  const why = (start: string, end: string | undefined) => {
    const { end: _, ...open } = recorded;
    const hold = end === undefined ? { ...open, start } : { ...open, start, end };
    return holdResult(`hold:${hold.id}`, hold, view.briefing, view.areas, now).why;
  };
  const start = "2026-11-06T04:07:05Z";
  const end = "2026-11-06T04:20:16Z";

  it("states both ends, or only the end it can read", () => {
    expect(why(start, end)).toBe("2026-11-06T04:07:05.000Z to 2026-11-06T04:20:16.000Z");
    expect(why(start, undefined)).toBe("since 2026-11-06T04:07:05.000Z");
    expect(why(start, "not-a-time")).toBe("from 2026-11-06T04:07:05.000Z");
    expect(why("not-a-time", end)).toBe("until 2026-11-06T04:20:16.000Z");
    expect(why("", "not-a-time")).toBe("");
    expect(why("not-a-time", undefined)).toBe("");
  });
});

describe("the rows apps/window/src/panels/detail-time.test.tsx draws", () => {
  it("answers partition's Main and Stack lane stations with instants in Related", async () => {
    const main = await resolveIn(scope, "station:partition:main");
    expect(main?.related[0]).toEqual({
      text: "Validation · success · 2026-11-05T14:35:22.000Z",
      state: "Main run",
      url: "https://github.com/Azure/osdu-spi-partition/actions/runs/42046459911",
    });
    const lane = await resolveIn(scope, "station:partition:lane");
    expect(lane?.related).toEqual([
      {
        text: "main · 830596b57d3813811de01000590aafabb4434c9f",
        state: "SUCCESS · 2026-11-05T14:44:20.000Z",
      },
    ]);
  });
});

describe("action reasons on the 6 Nov input, in the app's time style", () => {
  const both = ({ primary, secondary }: UpstreamActions) => [primary, ...secondary];
  const opts = { swept, load: model.lanes, now, context: ctx };
  const actions: ActionItem[] = [
    ...model.queue.items.flatMap((item) =>
      verbsOf(item, model, ctx, { ops: true, waiting: { id: "op-1", at: swept } }),
    ),
    ...both(planActions(model.upstream, opts)),
    ...model.upstream.forks.flatMap((f) => both(forkActions(model.upstream, f, opts))),
    ...rolloutActions(model.template, { swept }, now, ctx.fleet.forks, undefined, model.lanes, ctx),
  ];
  const said = actions.map(({ label, reason, confirm }) => ({ label, reason, confirm }));

  it("names times in what a press says, each as an instant", () => {
    expect(instantsIn(said)).toBeGreaterThan(0);
    noClocks(said);
  });
});
