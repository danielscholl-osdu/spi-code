// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { buildModel, repositoriesOf } from "@spi-code/core";
import { describe, expect, it } from "vitest";
import { fixtureInput } from "../../test/watch/snapshot-fixture.js";
import { repositoryLines } from "./repository-lines.js";

process.env.TZ = "UTC";

describe("Watch projection", () => {
  it("keeps distinct alert groups identifiable even when their displayed text is identical", () => {
    const input = fixtureInput();
    const now = input.context.clock.now();
    const model = buildModel(input.facts, now, {}, input.context);
    const repo = model.repositories.rows[0];
    const alert = model.repositories.rows.flatMap((r) => r.alerts).find((g) => g.source === "code");
    if (!repo || !alert) throw new Error("Fixture must have alert groups");
    repo.alerts = ["rule-a", "rule-b"].map((rule) => ({
      ...alert,
      id: `code:tool:${rule}:src`,
      rule,
      count: 2,
      owner: "spi",
      reach: "shipped",
    }));
    const projected = repositoryLines(repositoriesOf(model, now), model, now);
    const lines = projected.rows[0]?.sections.find((s) => s.title === "Code scanning")?.lines;
    expect(lines?.map((line) => line.id)).toEqual([
      `alert:${repo.repo}:code:tool:rule-a:src`,
      `alert:${repo.repo}:code:tool:rule-b:src`,
    ]);
    expect(new Set(lines?.map((line) => line.url)).size).toBe(2);
  });

  it("omits the optional id and url of a repository line it cannot match", () => {
    const input = fixtureInput();
    const now = input.context.clock.now();
    const model = buildModel(input.facts, now, {}, input.context);
    const repositories = repositoriesOf(model, now);
    const [row] = repositories.rows;
    const [section] = row?.sections ?? [];
    if (!row || !section) throw new Error("Fixture must have repository lines");
    const unmatched = {
      tag: "?",
      tone: "neutral",
      text: "Wording core has not shipped yet",
      sub: "",
    } as const;
    const projected = repositoryLines(
      {
        ...repositories,
        rows: [
          { ...row, sections: [{ ...section, lines: [...section.lines, unmatched] }] },
          { ...row, id: "repo:unknown" },
        ],
      },
      model,
      now,
    );
    expect(projected.rows[0]?.sections[0]?.lines.at(-1)).toEqual(unmatched);
    expect(projected.rows[0]?.sections[0]?.lines.slice(0, -1).every((l) => l.id && l.url)).toBe(
      true,
    );
    expect(projected.rows[1]).toEqual({ ...row, id: "repo:unknown" });
  });
});
