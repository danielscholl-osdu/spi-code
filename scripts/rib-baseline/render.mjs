// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const directory = process.argv[2];
assert.ok(directory, "Pass the fixture directory");
/** @param {string} name */
const read = (name) => JSON.parse(readFileSync(join(directory, name), "utf8"));
const settings = read("render.json");
assert.equal(process.env.TZ, settings.timezone);
assert.equal(new Intl.DateTimeFormat().resolvedOptions().locale, settings.locale);
assert.ok(read(settings.facts).github?.data, "Recorded GitHub facts must be present");
const now = new Date(settings.now);
const { Sweeper } = await import(new URL("./src/sweep.ts", import.meta.url).href);
const { Store } = await import(new URL("./src/store.ts", import.meta.url).href);
const { doctorStatus } = await import(new URL("./src/boards/doctor.ts", import.meta.url).href);
const { buildBriefing } = await import(new URL("./src/brief/index.ts", import.meta.url).href);
const { consoleHtml, expectHtml } = await import(
  new URL("./src/boards/console.ts", import.meta.url).href
);
const { monthFacts, releaseMonths } = await import(
  new URL("./src/model/releases.ts", import.meta.url).href
);
const { releaseDoc, releaseLine } = await import(
  new URL("./src/brief/release.ts", import.meta.url).href
);
const { readNotes } = await import(new URL("./src/notes/file.ts", import.meta.url).href);

const unreachable = () => {
  throw new Error("Baseline rendering must not call a forge");
};
const sweeper = new Sweeper({
  exec: { runJSON: unreachable, runText: unreachable },
  store: new Store(undefined),
  now: () => now,
  onChange: () => {},
});
const briefing = buildBriefing(sweeper.model, doctorStatus(sweeper.facts, now), now);
const reads = read(settings.releases);
/** @type {string[]} */
const months = releaseMonths(reads, now);
/** @type {{ month: string }[]} */
const lines = months.slice(0, settings.months).map((month) => {
  const notes = readNotes(join(directory, settings.notes), month);
  assert.notEqual(notes.state, "invalid", `Invalid notes for ${month}`);
  return releaseLine(releaseDoc(monthFacts(reads, month, now), notes, now));
});
const html = expectHtml(consoleHtml(briefing, now, { lines, reading: settings.reading }));
for (const pane of ["today", "repositories", "environment", "flow", "horizon", "releases"]) {
  assert.ok(html.includes(`data-view-pane="${pane}"`), `Missing ${pane} pane`);
}
assert.ok(
  lines.some((line) => line.month === "2026-10"),
  "October releases must be populated",
);
writeFileSync(join(directory, "console.html"), html);
