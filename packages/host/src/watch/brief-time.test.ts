// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { buildBriefing, buildModel, readItem } from "@spi-code/core";
import { expect, it } from "vitest";
import { appStyle, recordedInput } from "../../test/watch/snapshot-fixture.js";
import { projectWatch } from "./project.js";
import { readingFor } from "./readings.js";

const iso = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})\b/g;
const input = () => appStyle(recordedInput());
function noClocks(value: unknown) {
  expect(JSON.stringify(value).replace(iso, "instant")).not.toMatch(
    /\b\d{2}:\d{2}(?!\d)|Invalid Date|undefined|NaN|1970-01-01/,
  );
}

it("keeps the whole Nov 6 briefing and every reading free of clock text", () => {
  const { briefing, readings } = projectWatch(input());
  noClocks({ briefing, readings });
});

it.each(["service", "engineering", "environment", "releases"] as const)(
  "carries a synthetic %s due time through the host reader",
  (kind) => {
    const source = input();
    const view = projectWatch(source);
    const model = buildModel(source.facts, source.context.clock.now(), {}, source.context);
    const item = view.briefing.focus[0];
    if (!item) throw new Error("Recorded focus required");
    const scope = {
      service: "partition",
      engineering: "osdu-spi",
      environment: "Environment",
      releases: "Releases",
    }[kind];
    const due = { at: "2026-11-07T00:00:00Z", before: "sync" };
    view.briefing.focus = [{ ...item, id: "release-red:synthetic", scope, rung: 1, due }];
    view.briefing.rest = [];
    for (const at of ["2026-11-07T00:00:00Z", "bad"]) {
      due.at = at;
      const content = readingFor[kind](
        { kind: "service", id: "partition" },
        { input: source, model, briefing: view.briefing, documents: [], campaigns: [] },
      );
      expect(
        content?.items.some(
          ({ group }) =>
            group ===
            (at.endsWith("Z") ? "Before 2026-11-07T00:00:00.000Z" : "Before the next sync"),
        ),
      ).toBe(true);
      noClocks(content);
    }
  },
);

it("covers a failed smoke and a held environment, omitting unknown times", () => {
  const source = input();
  const { context, doctor } = source;
  const now = context.clock.now();
  const model = buildModel(source.facts, now, {}, context);
  const run = model.stack.lifecycle.smoke.runs[0];
  if (!run) throw new Error("Recorded smoke required");
  model.stack.lifecycle.smoke.runs = [
    {
      ...run,
      createdAt: "2026-11-06T12:00:00Z",
      updatedAt: "2026-11-06T12:01:00Z",
      status: "completed",
      conclusion: "failure",
      jobs: [],
    },
  ];
  const brief = () => buildBriefing(model, doctor, now, context);
  expect(brief().environment.headline).toContain(
    "smoke on a fresh cluster failed at 2026-11-06T12:00:00.000Z",
  );
  noClocks(brief());
  if (!model.stack.availability) throw new Error("Recorded availability required");
  model.stack.availability.since = Number.NaN;
  noClocks(brief());
  model.stack.attempts = [];
  delete model.stack.inflight;
  for (const since of ["2026-11-06T12:00:00Z", undefined, "bad"]) {
    model.stack.maintenance = { state: "set", ...(since !== undefined ? { since } : {}), run };
    const headline = brief().environment.headline;
    expect(headline).toContain(
      since?.endsWith("Z") ? "maintenance set at 2026-11-06T12:00:00.000Z" : "maintenance set by",
    );
    noClocks(brief());
  }
  const radar = model.queue.items.find(({ kind }) => kind === "radar");
  if (!radar) throw new Error("Recorded radar required");
  expect(readItem(model, radar, new Date("bad"), context).effect).toContain("at the next sync");
  noClocks(readItem(model, radar, new Date("bad"), context));
});
