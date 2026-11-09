// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import type { ForkEntry } from "../../src/collect/filters.js";
import { createContext } from "../../src/context.js";
import {
  approvalSection,
  type InspectOptions,
  rolloutActionItems,
  verbsOf,
} from "../../src/inspect/actions.js";
import { inspectItem } from "../../src/inspect/item.js";
import { buildModel } from "../../src/model/index.js";
import type { QueueItem } from "../../src/model/queue.js";
import { RIB_VOICE } from "../../src/voice.js";
import { fixtureContext } from "../briefing-setup.js";
import { FIXTURE_NOW, fixtureFacts, laneFacts } from "../harness.js";

// Digests of what the rib renders consoleHtml and its model from, recorded on main 322e474
// before reads were attached to FILTERS rows and action reasons. The models digest was
// re-recorded when findings that name no file took the settings reach (spicode-xzj), and when
// the template model gained its verified fork count (spicode-t1k.289); nothing else moved.
// Re-record only models with SPI_RECORD_MODEL_DIGEST=1.
const RECORDED = {
  models: "e155000cd799aec79b955c189d1aad53678b78004d193f23831223ea19ebee0b",
  inspections: "3777546a40cff0970a1bfbc65d5fd8b136ef0f788c30a17a6f3d4218152fddf6",
  actions: "744e914c0cb35180d704715989e9b450331b1cd93ca10a94bec0a38fce62ce05",
  filters: "a3bf2be2d43ccad1cc0367a70a25b6c9cdea8392b2c684ae8f8a8dd90b298cc4",
};

function digest(value: unknown): string {
  const text = JSON.stringify(value, (_, v) =>
    v instanceof Map ? { map: [...v] } : v instanceof Set ? { set: [...v] } : v,
  );
  return createHash("sha256").update(text).digest("hex");
}

const context = createContext({
  ...fixtureContext,
  clock: { now: () => FIXTURE_NOW },
  voice: RIB_VOICE,
});
const models = {
  fixture: buildModel(fixtureFacts(), FIXTURE_NOW, {}, context),
  lanes: buildModel(laneFacts(), FIXTURE_NOW, {}, context),
  down: buildModel(laneFacts(true), FIXTURE_NOW, {}, context),
};
const oracle: {
  cases: { fixture: keyof typeof models; item: QueueItem; opts: InspectOptions }[];
} = JSON.parse(
  readFileSync(
    new URL("../../../../fixtures/rib-59d6895/oracle/inspect-actions.json", import.meta.url),
    "utf8",
  ),
);
const halt: QueueItem = {
  id: "halt:svc",
  kind: "halt",
  rung: 0,
  scope: "svc",
  text: "",
  effects: [],
  cause: [],
  incident: true,
  blocks: 1,
  cls: "HALT",
  halt: { fork: "svc", code: "UNKNOWN_TOP_LEVEL", entries: ["a", "b"] },
};
const entries = (["listed", "absent", "unread", "unlisted", "absent"] as const).map(
  (state, i): ForkEntry => ({
    fork: `f${i}`,
    entry: i % 2 ? "a" : "b",
    state,
    ...(state === "listed" ? { verdict: "strip" } : {}),
    ...(state === "unread" ? {} : { url: `https://example.test/${i}` }),
    reads: [],
    attempted: [],
  }),
);

test("FILTERS reads and reason sources leave the rib's model, inspector and actions unchanged", () => {
  const all = Object.values(models);
  const actual = {
    models: digest(all),
    inspections: digest(
      all.flatMap((m) => m.queue.items.map((i) => inspectItem(m, i, FIXTURE_NOW, context))),
    ),
    actions: digest([
      ...oracle.cases.map((c) => [
        verbsOf(c.item, models[c.fixture], context, c.opts),
        approvalSection(c.item, models[c.fixture], c.opts),
      ]),
      ...all.flatMap((m) => m.queue.items.map((i) => verbsOf(i, m, context))),
      ...all.map((m) => rolloutActionItems(m, context)),
    ]),
    filters: digest(
      inspectItem(models.fixture, halt, FIXTURE_NOW, context, { others: { id: halt.id, entries } }),
    ),
  };
  if (process.env.SPI_RECORD_MODEL_DIGEST === "1") {
    const file = new URL(import.meta.url);
    const source = readFileSync(file, "utf8");
    const recorded = /(?<= {2}models: ")[a-f0-9]{64}(?=",)/;
    expect(source).toMatch(recorded);
    writeFileSync(file, source.replace(recorded, actual.models));
    RECORDED.models = actual.models;
  }
  expect(actual).toEqual(RECORDED);
});
