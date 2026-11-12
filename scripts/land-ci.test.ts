// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  branch,
  expectLanded,
  expectRefused,
  type Fixture,
  fixture,
  id,
  outsideCanary,
  run,
  testTimeout,
  toGitPath,
  useLandFixtures,
  withInheritedEnv,
} from "./land-fixture.js";

useLandFixtures();

describe("landing gates", () => {
  const anthropicBuild = { "build.provider": "anthropic", "build.model": "claude-opus-5.5" };

  it(
    "lands a matching review from a different provider and pushes it to origin",
    () => {
      const repo = fixture({ origin: true });
      const head = repo.commit("docs: update fixture");
      repo.review({
        ...anthropicBuild,
        "review.verdict": "pass",
        "review.provider": "openai",
        "review.patch_id": repo.patchId(),
      });

      expectLanded(repo, repo.land(), head);
      expect(repo.originMain()).toBe(head);
      expect(repo.landedCommits()).toBe(1);
    },
    testTimeout,
  );

  it(
    "pushes to the fixture origin, whatever git config, git function or bd function the caller's environment carries",
    () => {
      const canary = outsideCanary();
      const marker = join(canary.path, "bd-function-ran");
      const repo = fixture({ origin: true });
      const head = repo.commit("docs: update fixture");

      const result = withInheritedEnv(
        {
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "remote.origin.pushurl",
          GIT_CONFIG_VALUE_0: canary.url,
          GIT_CONFIG_KEY_1: `url.${canary.url}.insteadOf`,
          GIT_CONFIG_VALUE_1: repo.originUrl,
          "BASH_FUNC_git%%": `() { if [ "$3" = push ]; then command git -C "$2" push --quiet '${canary.url}' main; else command git "$@"; fi; }`,
          "BASH_FUNC_bd%%": `() { echo ran >> '${toGitPath(marker)}'; command bd "$@"; }`,
        },
        () => repo.land(),
      );

      expectLanded(repo, result, head);
      expect(repo.originMain()).toBe(head);
      expect(canary.refs()).toBe("");
      expect(existsSync(marker)).toBe(false);
    },
    testTimeout,
  );

  it(
    "keeps the bead open when the push fails, and a rerun finishes the same landing once",
    () => {
      const repo = fixture({ origin: true });
      const head = repo.commit("docs: update fixture");
      repo.rejectPushes(true);

      const failed = repo.land();

      expect(failed.error).toBeUndefined();
      expect(failed.status, failed.stdout + failed.stderr).toBe(1);
      expect(failed.stderr).toContain("the push failed");
      expect(failed.stderr).toContain(`rerun scripts/land ${id}`);
      expect(repo.main()).toBe(head);
      expect(repo.originMain()).toBe(repo.base);
      expect(repo.bead().status).toBe("in_progress");
      expect(repo.bead().metadata["land.sha"]).toBe(head);
      expect(repo.calls("close")).toEqual([]);
      expect(repo.calls("merge-slot release")).toHaveLength(1);
      expect(repo.checkRuns()).toBe(1);

      repo.rejectPushes(false);
      expectLanded(repo, repo.land(), head);
      expect(repo.originMain()).toBe(head);
      expect(repo.landedCommits()).toBe(1);
      expect(repo.calls("update")).toHaveLength(1);
      expect(repo.checkRuns()).toBe(1);
      expect(repo.calls("merge-slot release")).toHaveLength(2);
    },
    testTimeout,
  );
});

describe("landing through CI", () => {
  const gone = "0".repeat(40);
  const published = (head: string) =>
    new RegExp(`^refs/heads/land/${id}--${head.slice(0, 12)}-\\d+-\\d+ ${head}$`);
  function withOrigin() {
    const repo = fixture({ origin: true });
    repo.recordPushes();
    return { repo, head: repo.commit("docs: update fixture") };
  }
  // The land branches origin received, as [created, deleted] lines, in order.
  const landPushes = (repo: Fixture) => repo.pushed().filter((line) => line.includes("/land/"));

  it(
    "publishes the commit on a land branch, waits for its run, lands it and removes the branch",
    () => {
      const { repo, head } = withOrigin();
      repo.ci([], 1);
      repo.ci([], 2);
      repo.ci([run("in_progress", "")], 3);
      repo.ci([run("completed", "success")]);

      expectLanded(repo, repo.land(), head);
      expect(repo.originMain()).toBe(head);
      const [created, deleted, ...rest] = landPushes(repo);
      expect(created).toMatch(published(head));
      expect(deleted).toBe(`${created?.split(" ")[0]} ${gone}`);
      expect(rest).toEqual([]);
      expect(repo.originRefs()).not.toContain("/land/");
      expect(repo.checks()).toEqual(["ran --static"]);
      expect(repo.ghCalls("run list")).toHaveLength(4);
      expect(repo.ghCalls("run list")[0]).toContain(`--commit ${head}`);
      expect(repo.ghCalls("run rerun")).toEqual([]);
    },
    testTimeout,
  );

  it(
    "lands on a run the bead's own branch already passed, without a land branch",
    () => {
      const { repo, head } = withOrigin();

      expectLanded(repo, repo.land(), head);
      expect(repo.pushed()).toEqual([`refs/heads/main ${head}`]);
      expect(repo.ghCalls("run list")).toHaveLength(1);
    },
    testTimeout,
  );

  it(
    "ignores a failed run from the bead's branch and gets its own",
    () => {
      const { repo, head } = withOrigin();
      repo.ci([run("completed", "failure", branch)], 1);
      repo.ci([run("completed", "failure", branch), run("completed", "success")]);

      expectLanded(repo, repo.land(), head);
      expect(landPushes(repo)[0]).toMatch(published(head));
      expect(repo.ghCalls("run rerun")).toEqual([]);
    },
    testTimeout,
  );

  it(
    "reruns a failed run's failed jobs once, and lands when they pass",
    () => {
      const { repo, head } = withOrigin();
      repo.ci([], 1);
      repo.ci([run("completed", "failure")], 2);
      repo.ci([run("completed", "failure")], 3);
      repo.ci([run("queued", "", undefined, 2)], 4);
      repo.ci([run("completed", "success", undefined, 2)]);

      expectLanded(repo, repo.land(), head);
      expect(repo.ghCalls("run rerun")).toEqual(["run rerun 7 --failed"]);
      expect(repo.ghCalls("run list")).toHaveLength(5);
    },
    testTimeout,
  );

  it(
    "refuses after a second failure, leaving main alone and the land branch removed",
    () => {
      const { repo, head } = withOrigin();
      repo.ci([], 1);
      repo.ci([run("completed", "failure")], 2);
      repo.ci([run("completed", "failure", undefined, 2)]);

      const result = repo.land();

      expectRefused(repo, result, `CI failed twice on ${head}: https://ci.example.test/runs/7`);
      expect(repo.originMain()).toBe(repo.base);
      expect(repo.ghCalls("run rerun")).toEqual(["run rerun 7 --failed"]);
      expect(landPushes(repo)).toHaveLength(2);
      expect(repo.originRefs()).not.toContain("/land/");
      expect(repo.calls("merge-slot release")).toHaveLength(1);
    },
    testTimeout,
  );

  it.each([
    ["this commit", (head: string) => head],
    ["an older commit", (_head: string, base: string) => base],
  ])(
    "publishes under a new name beside a branch an interrupted landing left at %s, and removes both",
    (_name, at) => {
      const { repo, head } = withOrigin();
      const left = `refs/heads/land/${id}--left-1-1`;
      repo.git("push", "--quiet", "origin", `${at(head, repo.base)}:${left}`);
      repo.ci([], 1);
      repo.ci([run("completed", "success")]);

      expectLanded(repo, repo.land(), head);
      const created = landPushes(repo).filter(
        (line) => !line.startsWith(left) && line.endsWith(head),
      );
      expect(created).toHaveLength(1);
      expect(created[0]).toMatch(published(head));
      expect(repo.originRefs()).not.toContain("/land/");
    },
    testTimeout,
  );

  it(
    "refuses at once when origin already has the branch name it chose, since no run would start",
    () => {
      const { repo, head } = withOrigin();
      const taken = `land/${id}--${head.slice(0, 12)}-taken`;
      repo.git("push", "--quiet", "origin", `${head}:refs/heads/${taken}`);
      repo.ci([]);

      const result = repo.land({ SPI_LAND_RUN: "taken" });

      expectRefused(repo, result, `origin already has ${taken}, so no run was started`);
      expect(repo.ghCalls("run list")).toHaveLength(1);
      expect(repo.originRefs()).not.toContain("/land/");
    },
    testTimeout,
  );

  it(
    "removes an interrupted landing's branch even when it lands on the bead branch's run",
    () => {
      const { repo, head } = withOrigin();
      repo.git("push", "--quiet", "origin", `${head}:refs/heads/land/${id}--left-1-1`);

      expectLanded(repo, repo.land(), head);
      expect(repo.originRefs()).not.toContain("/land/");
    },
    testTimeout,
  );

  it(
    "leaves another bead's land branch alone",
    () => {
      const { repo, head } = withOrigin();
      repo.git("push", "--quiet", "origin", `${head}:refs/heads/land/${id}-other--left-1-1`);

      expectLanded(repo, repo.land(), head);
      expect(repo.originRefs()).toContain(`refs/heads/land/${id}-other--left-1-1`);
    },
    testTimeout,
  );

  it(
    "refuses a run that does not finish by the deadline",
    () => {
      const { repo, head } = withOrigin();
      repo.ci([run("in_progress", "", branch)]);

      const result = repo.land({ SPI_LAND_CI_TIMEOUT: "0" });

      expectRefused(repo, result, `CI did not finish on ${head} within 0s`);
      expect(landPushes(repo)).toEqual([]);
    },
    testTimeout,
  );

  it(
    "refuses before asking CI when the review does not hold",
    () => {
      const { repo } = withOrigin();
      repo.review({ "build.provider": "anthropic" });

      expectRefused(repo, repo.land(), "has no passing review");
      expect(repo.ghCalls("run")).toEqual([]);
    },
    testTimeout,
  );

  it(
    "runs the whole check here and asks CI nothing when there is no remote",
    () => {
      const repo = fixture();
      const head = repo.commit("docs: update fixture");

      expectLanded(repo, repo.land(), head);
      expect(repo.checks()).toEqual(["ran "]);
      expect(repo.ghCalls("run")).toEqual([]);
    },
    testTimeout,
  );

  it(
    "runs the whole check here, asks CI nothing and says so under SPI_LAND_LOCAL",
    () => {
      const { repo, head } = withOrigin();

      const result = repo.land({ SPI_LAND_LOCAL: "1" });

      expectLanded(repo, result, head);
      expect(result.stdout).toContain("checked on this machine only");
      expect(repo.checks()).toEqual(["ran "]);
      expect(repo.ghCalls("run")).toEqual([]);
      expect(repo.pushed()).toEqual([`refs/heads/main ${head}`]);
    },
    testTimeout,
  );
});
