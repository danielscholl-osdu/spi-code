// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  branch,
  expectLanded,
  expectRefused,
  fixture,
  id,
  testTimeout,
  useLandFixtures,
} from "./land-fixture.js";

useLandFixtures();

describe("landing gates", () => {
  const anthropicBuild = { "build.provider": "anthropic", "build.model": "claude-opus-5.5" };

  it.each([
    ["absent", {}],
    ["failing", { "review.verdict": "fail", "review.provider": "openai" }],
  ])(
    "refuses a bead whose review is %s",
    (_name, review) => {
      const repo = fixture();
      repo.commit("docs: update fixture");
      repo.review({ ...anthropicBuild, ...review });

      expectRefused(repo, repo.land(), `${id} has no passing review`);
    },
    testTimeout,
  );

  it(
    "refuses a review whose patch-id no longer matches the diff",
    () => {
      const repo = fixture();
      repo.commit("docs: update fixture");
      const reviewed = repo.patchId();
      repo.review({
        ...anthropicBuild,
        "review.verdict": "pass",
        "review.provider": "openai",
        "review.patch_id": reviewed,
      });
      repo.commit("docs: change after review");
      const current = repo.patchId();
      expect(current).not.toBe(reviewed);

      expectRefused(
        repo,
        repo.land(),
        `the diff changed since review (${current} vs ${reviewed}); review again`,
      );
    },
    testTimeout,
  );

  const lines = (changed: Record<number, string> = {}) =>
    Array.from({ length: 9 }, (_, index) => `${changed[index + 1] ?? `line ${index + 1}`}\n`).join(
      "",
    );
  const pass = { ...anthropicBuild, "review.verdict": "pass", "review.provider": "openai" };
  const passedAt = (head: string) => ({ ...pass, "review.head": head });
  // A bead that changes line 5 of a nine-line file main already holds.
  function notesBead() {
    const repo = fixture();
    repo.write("main", "notes.md", lines());
    repo.rebase();
    repo.write("bead", "notes.md", lines({ 5: "the bead's line" }));
    return repo;
  }

  it(
    "keeps a review when main gains an edit beside the bead's lines, and drops the pin",
    () => {
      const repo = notesBead();
      repo.review(passedAt(repo.reviewHead()));
      expect(repo.refs("refs/reviewed")).toBe(`refs/reviewed/${id}`);
      repo.write("main", "notes.md", lines({ 3: "a neighbour's line" }));

      const result = repo.land();

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(repo.bead().status).toBe("closed");
      expect(repo.refs("refs/reviewed")).toBe("");
    },
    testTimeout,
  );

  it(
    "refuses the same neighbour's edit for a pass recorded against the whole diff",
    () => {
      const repo = notesBead();
      repo.review({ ...pass, "review.patch_id": repo.patchId() });
      repo.write("main", "notes.md", lines({ 3: "a neighbour's line" }));

      const result = repo.land();

      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain("the diff changed since review");
    },
    testTimeout,
  );

  it(
    "keeps a review when the builder rebases cleanly after it",
    () => {
      const repo = notesBead();
      repo.review(passedAt(repo.reviewHead()));
      repo.write("main", "notes.md", lines({ 3: "a neighbour's line" }));
      repo.rebase();

      const result = repo.land();

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(repo.bead().status).toBe("closed");
    },
    testTimeout,
  );

  it(
    "refuses the reviewed edit moved to an identical line elsewhere",
    () => {
      const repo = fixture();
      const same = { 2: "return false;", 7: "return false;" };
      repo.write("main", "notes.md", lines(same));
      repo.rebase();
      repo.write("bead", "notes.md", lines({ ...same, 2: "return true;" }));
      const reviewed = repo.reviewHead();
      repo.review(passedAt(reviewed));
      repo.amend("notes.md", lines({ ...same, 7: "return true;" }));

      const result = repo.land();

      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain(`differs from the reviewed commit ${reviewed}`);
      expect(repo.bead().status).toBe("in_progress");
    },
    testTimeout,
  );

  it(
    "refuses a commit added after the review",
    () => {
      const repo = fixture();
      repo.commit("docs: update fixture");
      const reviewed = repo.reviewHead();
      repo.review(passedAt(reviewed));
      repo.commit("docs: change after review");

      expectRefused(repo, repo.land(), `differs from the reviewed commit ${reviewed}`);
    },
    testTimeout,
  );

  it(
    "refuses when the reviewed commit conflicts with what main has since gained",
    () => {
      const repo = notesBead();
      const reviewed = repo.reviewHead();
      repo.review(passedAt(reviewed));
      repo.write("main", "notes.md", lines({ 5: "a neighbour took the same line" }));
      repo.amend("notes.md", lines({ 9: "the bead moved out of the way" }));

      const result = repo.land();

      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain(`${reviewed} no longer merges cleanly with main`);
    },
    testTimeout,
  );

  it(
    "keeps a review when only a generated watch fixture changes, and still runs the checks",
    () => {
      const repo = fixture();
      repo.commit("docs: update fixture");
      repo.review(passedAt(repo.reviewHead()));
      const head = repo.write("bead", "fixtures/watch/snapshot-calm.json", "{}\n");

      expectLanded(repo, repo.land(), head);
      expect(repo.checkRuns()).toBe(1);
    },
    testTimeout,
  );

  it(
    "refuses a review after a fixture no test regenerates changes",
    () => {
      const repo = fixture();
      repo.commit("docs: update fixture");
      const reviewed = repo.reviewHead();
      repo.review(passedAt(reviewed));
      repo.write("bead", "fixtures/watch/inspect-stations-legal-59d6895.json", "{}\n");

      expectRefused(repo, repo.land(), `differs from the reviewed commit ${reviewed}`);
    },
    testTimeout,
  );

  it.each([
    ["the bead's branch", branch],
    ["HEAD", "HEAD"],
    ["a short id", (head: string) => head.slice(0, 12)],
  ] as const)(
    "refuses a pass recorded against %s, which a later commit would move",
    (_name, recorded) => {
      const repo = fixture();
      const head = repo.commit("docs: update fixture");
      repo.review(passedAt(typeof recorded === "string" ? recorded : recorded(head)));

      expectRefused(repo, repo.land(), "review.head must be a full commit id");
    },
    testTimeout,
  );

  it(
    "refuses a submodule moved after the review, even where git is told to ignore submodules",
    () => {
      const repo = fixture();
      repo.write(
        "main",
        ".gitmodules",
        '[submodule "vendored"]\n\tpath = vendored\n\turl = ./vendored\n\tignore = all\n',
      );
      repo.gitlink("main", "vendored", repo.base);
      repo.rebase();
      repo.commit("docs: update fixture");
      const reviewed = repo.reviewHead();
      repo.review(passedAt(reviewed));
      repo.gitlink("bead", "vendored", reviewed);

      const result = repo.land();

      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain(`differs from the reviewed commit ${reviewed}`);
    },
    testTimeout,
  );

  it(
    "refuses a later commit even when a replacement object stands in for the reviewed tree",
    () => {
      const repo = fixture();
      repo.commit("docs: update fixture");
      const reviewed = repo.reviewHead();
      repo.review(passedAt(reviewed));
      const head = repo.commit("docs: change after review");
      repo.git(
        "replace",
        repo.git("rev-parse", `${reviewed}^{tree}`),
        repo.git("rev-parse", `${head}^{tree}`),
      );

      const result = repo.land();

      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain(`differs from the reviewed commit ${reviewed}`);
    },
    testTimeout,
  );

  it(
    "refuses a reviewed commit the repository does not hold",
    () => {
      const repo = fixture();
      repo.commit("docs: update fixture");
      repo.review(passedAt("0123456789abcdef0123456789abcdef01234567"));

      expectRefused(repo, repo.land(), "is not in this repository; review again");
    },
    testTimeout,
  );

  it(
    "refuses a pass that records neither a reviewed commit nor an id",
    () => {
      const repo = fixture();
      repo.commit("docs: update fixture");
      repo.review({ ...pass, "review.head": "", "review.patch_id": "" });

      expectRefused(repo, repo.land(), "review again");
    },
    testTimeout,
  );

  it(
    "refuses a review from the author's own provider",
    () => {
      const repo = fixture();
      repo.commit("docs: update fixture");
      repo.review({
        ...anthropicBuild,
        "review.verdict": "pass",
        "review.provider": "anthropic",
        "review.patch_id": repo.patchId(),
      });

      expectRefused(repo, repo.land(), "the reviewer's provider (anthropic) is the author's");
    },
    testTimeout,
  );
});
