// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  AREAS,
  type AreaEnvelope,
  type AreaName,
  type ReadRecord,
  type TodayLine,
  type TodayMember,
} from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import {
  type EvidenceRoute,
  openEvidence,
  openSelection,
  parseRoute,
  setOpenSelection,
} from "../../app/navigation.js";
import { EvidencePage, type EvidenceSnapshot } from "./EvidencePage.js";
import { AREA_NAMES } from "./words.js";

const now = Date.parse("2026-11-17T01:10:00Z");
const sweptAt = "2026-11-17T01:06:12Z";
const at = (minutes: number) => new Date(Date.parse(sweptAt) - minutes * 60_000).toISOString();

const areas: AreaEnvelope[] = AREAS.map((area) => ({
  area,
  envelope: {
    source: area,
    state: "fresh",
    observedAt: at(area === "details" ? 14 : 1),
    completeness: { kind: "complete" },
  },
}));

const member = (
  id: string,
  fork: string,
  evidence: Partial<TodayMember["evidence"]> = {},
): TodayMember => ({
  id,
  ids: [id],
  fork,
  cause: "",
  effect: "",
  steps: [],
  evidence: { areas: ["github", "details"], attributed: "item", notRead: [], ...evidence },
});

const line = (id: string, subject: string, members: TodayMember[]): TodayLine => ({
  id,
  section: "waiting",
  subject,
  headline: `${subject} headline`,
  cause: "",
  effect: "",
  steps: [],
  members,
});

const LINES: TodayLine[] = [
  line("waiting:gate2:storage", "storage", [
    member("gate2:storage", "storage", { notRead: ["Validation Summary job"] }),
  ]),
  line("waiting:upgrade:os-core-common", "2 forks", [
    member("gate1:storage", "storage", { areas: ["github", "upstream"] }),
    member("gate1:indexer", "indexer", {
      areas: ["github", "upstream"],
      notRead: ["Whether the other lanes have drained"],
    }),
  ]),
  line("waiting:radar:partition", "partition", [
    member("radar:partition", "partition", { attributed: "sweep", areas: [...AREAS] }),
  ]),
];

const read = (source: string, object: string, minutes = 2): ReadRecord => ({
  source,
  object,
  observedAt: at(minutes),
  completeness: { kind: "complete" },
});

const READS: ReadRecord[] = [
  read("Azure/osdu-spi-storage", "port PRs"),
  read("Azure/osdu-spi-storage", "main:pom.xml", 3),
  read("osdu/platform/system/storage", "merged MRs"),
  read("Azure/osdu-spi-indexer", "port PRs"),
  read("osdu/platform/system/indexer-service", "merged MRs"),
  read("osdu/platform/system/indexer-service", "merge_requests/1248/diffs", 4),
  read("Azure/osdu-spi-partition", ".github/upstream-filter.yml"),
  read("osdu/platform/system/partition", "repository/tree?ref=master"),
  read("Azure/osdu-spi-legal", "port PRs"),
];

const snapshot: EvidenceSnapshot = {
  sweptAt,
  areas,
  provenance: [],
  reads: READS,
  briefing: { lines: LINES },
};

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  setOpenSelection(null);
  window.location.hash = "";
});

async function render(route: EvidenceRoute, body = snapshot) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(<EvidencePage route={route} snapshot={body} sweep={null} now={now} />),
  );
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  const page = container.querySelector<HTMLElement>("[data-evidence-page]");
  return {
    page,
    parts: () =>
      [...(page?.querySelectorAll("[data-evidence-part]") ?? [])].map((part) =>
        part.getAttribute("data-evidence-part"),
      ),
    headings: () => [...(page?.querySelectorAll("h3") ?? [])].map((h) => h.textContent),
    names: (label: string) =>
      [
        ...(page?.querySelectorAll(
          `table[aria-label="${label}"] th, ul[aria-label="${label}"] .evidence-read-object`,
        ) ?? []),
      ].map((name) => name.textContent),
    click: (selector: string) =>
      act(async () => page?.querySelector<HTMLButtonElement>(selector)?.click()),
  };
}

const item = (id: string): EvidenceRoute => ({
  kind: "evidence",
  from: { kind: "today" },
  selection: { kind: "item", id },
});

it("lists an item's not-read first, then its fork's reads with times, then its areas", async () => {
  const view = await render(item("gate2:storage"));
  expect(view.parts()).toEqual(["not-read", "reads", "areas"]);
  expect(view.headings()).toEqual(["Not read", "Reads of Azure/osdu-spi-storage", "Areas"]);
  expect(view.page?.querySelector(".evidence-not-read")?.textContent).toBe(
    "⌀ Validation Summary job",
  );
  expect(view.names("Reads of Azure/osdu-spi-storage")).toEqual(["port PRs", "main · pom.xml"]);
  expect(view.names("Areas")).toEqual([AREA_NAMES.github, AREA_NAMES.details]);
  expect(view.page?.textContent).toContain("14 min before the sweep ended");
  expect(view.page?.textContent).toContain("SPI Code read this item from these areas.");
  expect(view.page?.textContent).not.toMatch(/GitLab|indexer|partition/);
});

it("lists a group's not-read, the reads of each member fork, then GitLab's for upstream work", async () => {
  const view = await render({
    kind: "evidence",
    selection: { kind: "line", id: "waiting:upgrade:os-core-common" },
  });
  expect(view.parts()).toEqual(["not-read", "reads", "gitlab-reads", "gitlab-reads", "areas"]);
  expect(view.headings()).toEqual([
    "Not read",
    "Reads of the forks in this row",
    "Reads of GitLab osdu/platform/system/storage",
    "Reads of GitLab osdu/platform/system/indexer-service",
    "Areas",
  ]);
  expect(view.names("Reads of the forks in this row")).toEqual([
    "storage · port PRs",
    "storage · main · pom.xml",
    "indexer · port PRs",
  ]);
  expect(view.names("Reads of GitLab osdu/platform/system/indexer-service")).toEqual(["2 reads"]);
  expect(view.names("Areas")).toEqual([AREA_NAMES.github, AREA_NAMES.upstream]);
});

it("lists an upstream item's fork reads, then its GitLab project's, then the sweep's areas", async () => {
  const view = await render(item("radar:partition"));
  expect(view.parts()).toEqual(["reads", "gitlab-reads", "areas"]);
  expect(view.headings()).toEqual([
    "Reads of Azure/osdu-spi-partition",
    "Reads of GitLab osdu/platform/system/partition",
    "Areas",
  ]);
  expect(view.names("Areas")).toEqual(AREAS.map((area) => AREA_NAMES[area]));
  expect(view.page?.textContent).toContain("so this is the sweep's list");
});

it("says a fork has no reads rather than borrowing another fork's", async () => {
  const bare = { ...snapshot, reads: READS.filter(({ source }) => !source.endsWith("storage")) };
  const view = await render(item("gate2:storage"), bare);
  expect(view.parts()).toEqual(["not-read", "reads", "areas"]);
  expect(view.page?.querySelector("[aria-label^='Reads of']")).toBeNull();
  expect(view.page?.textContent).toContain("No reads recorded for storage.");
});

it("goes back to the page and selection it came from, and Whole sweep shows every area", async () => {
  window.location.hash = "#service/storage";
  setOpenSelection({ kind: "item", id: "gate2:storage" });
  openEvidence();
  const route = parseRoute(window.location.hash);
  expect(route).toEqual({
    kind: "evidence",
    from: { kind: "service", id: "storage" },
    selection: { kind: "item", id: "gate2:storage" },
  });
  const view = await render(route as EvidenceRoute);
  expect(view.page?.querySelector("[data-evidence-back]")?.textContent).toBe("‹ storage");
  await view.click("[data-evidence-whole]");
  expect(parseRoute(window.location.hash)).toEqual({
    kind: "evidence",
    from: { kind: "service", id: "storage" },
  });
  await view.click("[data-evidence-back]");
  expect(window.location.hash).toBe("#service/storage");
  expect(openSelection()).toEqual({ kind: "item", id: "gate2:storage" });

  const whole = await render({ kind: "evidence" });
  expect(whole.page?.querySelector("[data-evidence-back]")?.textContent).toBe("‹ Today");
  expect(whole.page?.querySelector("[data-evidence-whole]")).toBeNull();
  const sources = [
    ...(whole.page?.querySelectorAll('[aria-label="Sources"] .sweep-row .sweep-name') ?? []),
  ].map((name) => name.textContent);
  expect(sources).toEqual(AREAS.map((area: AreaName) => AREA_NAMES[area]));
});

it("says a selection the briefing no longer holds is gone and keeps Whole sweep", async () => {
  const view = await render(item("gate2:gone"));
  expect(view.page?.querySelector(".evidence-lede")?.textContent).toContain(
    "This selection is no longer on Today",
  );
  expect(view.parts()).toEqual([]);
  expect(view.page?.querySelector("[data-evidence-whole]")).not.toBeNull();
});
