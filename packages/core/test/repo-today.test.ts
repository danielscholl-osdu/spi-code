// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { todayLines } from "../src/brief/lines";
import { repositoryToday, syncCompanions } from "../src/brief/repo-today";
import type { Facts } from "../src/facts";
import {
  sweep1116Context as context,
  SWEEP_1116_NOW as now,
  sweep1116Facts,
  sweep1116Items,
  sweep1116Model,
} from "./sweep-1116";

const gh = "https://github.com/Azure/osdu-spi-";
const issue = (repo: string, n: number) => `${gh}${repo}/issues/${n}`;
const pull = (repo: string, n: number) => `${gh}${repo}/pull/${n}`;

function today(
  facts: Facts = sweep1116Facts(),
  edit?: (items: ReturnType<typeof sweep1116Items>) => void,
) {
  const model = sweep1116Model(facts);
  const items = sweep1116Items(model);
  edit?.(items);
  return repositoryToday(model, items, todayLines(model, items, now, context));
}

const COMPANIONS: [string, number, number][] = [
  ["search", 78, 77],
  ["workflow", 61, 60],
  ["unit", 51, 50],
  ["crs-catalog", 55, 54],
  ["crs-conversion", 42, 41],
];

describe("Repository lines resolved to Today members on the 16 Nov sweep", () => {
  test("each Ready for Review issue resolves to its sync PR's Today member, and no other issue does", () => {
    expect(syncCompanions(sweep1116Model())).toEqual(
      new Map(COMPANIONS.map(([repo, i, pr]) => [issue(repo, i), pull(repo, pr)])),
    );
    const marks = today(undefined, (items) => {
      const halt = items.find(({ id }) => id === "halt:crs-conversion");
      if (!halt) throw new Error("Missing halt item");
      halt.evidence = [];
    });
    for (const [repo, i, pr] of COMPANIONS) {
      expect(marks.get(pull(repo, pr))).toEqual({ id: `gate1:${repo}`, rel: "source" });
      expect(marks.get(issue(repo, i))).toEqual({ id: `gate1:${repo}`, rel: "companion" });
    }
    expect(marks.get(issue("crs-conversion", 44))).toEqual({
      id: "halt:crs-conversion",
      rel: "source",
    });
    expect(marks.get(issue("indexer", 72))).toEqual({ id: "sync-run:indexer", rel: "source" });
    for (const unrelated of [
      issue("search", 65),
      issue("search", 73),
      issue("storage", 67),
      issue("partition", 245),
    ])
      expect(marks.has(unrelated)).toBe(false);
  });

  test.each<[string, (f: Facts) => void]>([
    [
      "a second Ready for Review issue waiting on the merge",
      (f: Facts) => {
        const repo = f.github.data?.repos["Azure/osdu-spi-search"];
        const first = repo?.issues.find((i) => i.number === 78);
        if (!repo || !first) throw new Error("search #78 missing");
        repo.issues.push({ ...first, number: 90, url: issue("search", 90) });
      },
    ],
    [
      "a second sync PR into fork_upstream",
      (f: Facts) => {
        const repo = f.github.data?.repos["Azure/osdu-spi-search"];
        const sync = repo?.prs.find((p) => p.number === 77);
        if (!repo || !sync) throw new Error("search #77 missing");
        repo.prs.push({
          ...sync,
          number: 91,
          url: pull("search", 91),
          head: "sync/upstream-20261112-000000",
        });
      },
    ],
    [
      "the issue opened before the sync PR",
      (f: Facts) => {
        const companion = f.github.data?.repos["Azure/osdu-spi-search"]?.issues.find(
          (i) => i.number === 78,
        );
        if (!companion) throw new Error("search #78 missing");
        companion.createdAt = "2026-11-10T00:00:00Z";
      },
    ],
    ...(
      [
        ["issue", "not a date"],
        ["issue", ""],
        ["sync PR", "not a date"],
        ["sync PR", ""],
      ] as const
    ).map(
      ([side, createdAt]) =>
        [
          `the ${side} createdAt is ${JSON.stringify(createdAt)}`,
          (f: Facts) => {
            const repo = f.github.data?.repos["Azure/osdu-spi-search"];
            const target =
              side === "issue"
                ? repo?.issues.find((i) => i.number === 78)
                : repo?.prs.find((p) => p.number === 77);
            if (!target) throw new Error(`search ${side} missing`);
            target.createdAt = createdAt;
          },
        ] as [string, (f: Facts) => void],
    ),
    [
      "issues the page did not reach",
      (f: Facts) => {
        const repo = f.github.data?.repos["Azure/osdu-spi-search"];
        if (!repo) throw new Error("search missing");
        repo.openIssues = repo.issues.length + 1;
      },
    ],
  ])("an ambiguous or unproven companion stays unassociated: %s", (_, edit) => {
    const facts = sweep1116Facts();
    edit(facts);
    const marks = today(facts);
    expect(marks.has(issue("search", 78))).toBe(false);
    expect(marks.get(issue("workflow", 61))).toEqual({ id: "gate1:workflow", rel: "companion" });
  });

  test.each(["system", undefined])(
    "an item whose move is not the operator's claims nothing (actor %s)",
    (actor) => {
      const marks = today(undefined, (items) => {
        for (const item of items)
          if (item.scope === "search" || item.id === "halt:crs-conversion") {
            if (actor) item.actor = actor as typeof item.actor;
            else delete item.actor;
          }
      });
      for (const url of [issue("search", 78), pull("search", 77), issue("crs-conversion", 44)])
        expect(marks.has(url)).toBe(false);
      expect(marks.get(issue("crs-conversion", 42))).toEqual({
        id: "gate1:crs-conversion",
        rel: "companion",
      });
    },
  );

  test("a URL two Today members claim marks neither", () => {
    const marks = today(undefined, (items) => {
      const halt = items.find((i) => i.id === "halt:crs-conversion");
      const sync = items.find((i) => i.id === "sync-run:indexer");
      if (!halt || !sync) throw new Error("items missing");
      sync.evidence.push({ label: "issue #44", url: issue("crs-conversion", 44) });
    });
    expect(marks.has(issue("crs-conversion", 44))).toBe(false);
    expect(marks.get(issue("indexer", 72))).toEqual({ id: "sync-run:indexer", rel: "source" });
  });
});
