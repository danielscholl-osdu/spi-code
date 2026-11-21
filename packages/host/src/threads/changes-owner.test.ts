// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pathRuleForWorktree, withPathOwners } from "./changes-owner.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});

describe("changed file ownership", () => {
  it("reads the service's filter and leaves an unplaced path untagged", async () => {
    const root = await mkdtemp(join(tmpdir(), "spi-change-owner-"));
    roots.push(root);
    await mkdir(join(root, ".github"));
    await writeFile(
      join(root, ".github/upstream-filter.yml"),
      [
        "service: partition",
        "top_level:",
        "  partition-core: keep",
        "fork_owned:",
        "  - provider/partition-azure",
        "",
      ].join("\n"),
    );
    const rule = await pathRuleForWorktree("partition", root);
    const changes = withPathOwners(
      {
        state: "read",
        head: "c".repeat(40),
        ahead: 0,
        uncommitted: true,
        files: [
          { path: "provider/partition-azure/A.java", added: 1, removed: 0, untracked: false },
          { path: "partition-core/B.java", added: 1, removed: 0, untracked: false },
          { path: "not-in-the-filter/C.java", added: 1, removed: 0, untracked: false },
        ],
      },
      rule,
    );
    if (changes.state !== "read") throw new Error("Missing read changes");
    expect(changes.files).toEqual([
      expect.objectContaining({ path: "provider/partition-azure/A.java", owner: "fork" }),
      expect.objectContaining({ path: "partition-core/B.java", owner: "upstream" }),
      expect.not.objectContaining({ path: "not-in-the-filter/C.java", owner: expect.anything() }),
    ]);
  });

  it("returns no rule when the filter is absent or belongs to another service", async () => {
    const root = await mkdtemp(join(tmpdir(), "spi-change-owner-"));
    roots.push(root);
    expect(await pathRuleForWorktree("partition", root)).toBeUndefined();
    await mkdir(join(root, ".github"));
    await writeFile(join(root, ".github/upstream-filter.yml"), "service: legal\n");
    expect(await pathRuleForWorktree("partition", root)).toBeUndefined();
  });
});
