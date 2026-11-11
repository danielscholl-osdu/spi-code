// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  parseCrons,
  parseDeclaration,
  parseGithub,
  parseHalt,
  parseRepo,
  parseUpstreamSha,
} from "../../src/collect/github-parse";
import { fleetOf, STACK_REPO } from "../../src/config";
import { createContext } from "../../src/context";
import { buildWork } from "../../src/model/work";
import services from "../fixtures/rib-59d6895/services.json";

const context = createContext({ fleet: fleetOf(services) });

describe("GraphQL query", () => {
  test("the template's merged PRs keep their author and a fork reads its Sync Template schedule", () => {
    const facts = parseGithub(
      {
        r_template: {
          nameWithOwner: "Azure/osdu-spi",
          url: "https://github.com/Azure/osdu-spi",
          pastPrs: {
            nodes: [
              {
                number: 254,
                title: "build(deps): bump setup-java",
                url: "u",
                createdAt: "2026-10-11T00:00:00Z",
                mergedAt: "2026-10-12T00:00:00Z",
                headRefName: "dependabot/github_actions/setup-java-5",
                baseRefName: "main",
                author: { login: "dependabot" },
              },
            ],
          },
        },
        r_fork0: {
          nameWithOwner: "Azure/osdu-spi-partition",
          url: "https://github.com/Azure/osdu-spi-partition",
          syncTemplate: { text: "on:\n  schedule:\n    - cron: '0 8 * * *'\n" },
        },
      },
      context,
    );
    expect(facts.repos["Azure/osdu-spi"]?.pastPrs?.[0]?.author).toBe("dependabot");
    expect(facts.repos["Azure/osdu-spi"]?.syncCrons).toBeUndefined();
    expect(facts.repos["Azure/osdu-spi-partition"]?.syncCrons).toEqual(["0 8 * * *"]);
  });

  test("the stack's releases and workflow schedules, and a fork's past gates, are parsed", () => {
    const facts = parseGithub(
      {
        r_stack: {
          nameWithOwner: "Azure/osdu-spi-stack",
          url: "https://github.com/Azure/osdu-spi-stack",
          releases: {
            nodes: [
              { tagName: "v0.28.3", publishedAt: "2026-10-13T00:18:28Z", url: "u3" },
              { tagName: "v0.29.0", publishedAt: null, url: "u4", isDraft: true },
            ],
          },
          wf_refresh: { text: 'on:\n  schedule:\n    - cron: "0 4 * * 1-5"\n' },
          wf_upgrade: { text: "on:\n  push:\n" },
          wf_smoke: null,
        },
        r_fork0: {
          nameWithOwner: "Azure/osdu-spi-legal",
          url: "https://github.com/Azure/osdu-spi-legal",
          pastPrs: {
            nodes: [
              {
                number: 21,
                title: "Sync with upstream",
                url: "u21",
                createdAt: "2026-09-30T00:08:00Z",
                mergedAt: "2026-09-30T01:33:00Z",
                closedAt: "2026-09-30T01:33:00Z",
                headRefName: "sync/upstream-20260930",
                baseRefName: "fork_upstream",
              },
            ],
          },
          pastIssues: {
            nodes: [
              {
                number: 9,
                url: "u9",
                createdAt: "2026-09-30T01:34:00Z",
                closedAt: "2026-09-30T01:38:00Z",
                labels: { nodes: [{ name: "conflict" }] },
              },
            ],
          },
        },
      },
      context,
    );
    const stack = facts.repos["Azure/osdu-spi-stack"];
    expect(stack?.releases).toEqual([{ tag: "v0.28.3", at: "2026-10-13T00:18:28Z", url: "u3" }]);
    expect(stack?.schedules).toEqual({ refresh: ["0 4 * * 1-5"], upgrade: [], smoke: [] });
    const legal = facts.repos["Azure/osdu-spi-legal"];
    expect(legal?.pastPrs?.[0]).toMatchObject({ number: 21, head: "sync/upstream-20260930" });
    expect(legal?.pastIssues?.[0]).toMatchObject({ number: 9, labels: ["conflict"] });
    expect(legal?.releases).toBeUndefined();
  });

  test("a planned repository that does not exist reads as missing, not as an error", () => {
    const facts = parseGithub(
      {
        rateLimit: { remaining: 4900, resetAt: "2026-10-12T22:19:00Z" },
        p_0: null,
        p_1: { nameWithOwner: "Azure/osdu-spi-indexer" },
        p_2: null,
      },
      context,
    );
    expect(facts.planned).toEqual({ storage: false, indexer: true, search: false });
    expect(facts.rate?.remaining).toBe(4900);
  });

  test("planned aliases follow each supplied fleet independently, including an empty list", () => {
    const other = createContext({
      fleet: fleetOf([
        { id: "future-b", upstream: "custom/b" },
        { id: "existing", repo: "custom/existing", upstream: "custom/existing" },
        { id: "future-a", upstream: "custom/a" },
      ]),
    });
    const empty = createContext({ fleet: fleetOf([]) });
    const data = { p_0: null, p_1: { nameWithOwner: "custom/future-a" }, p_2: null };
    for (const ctx of [other, context, empty, other, context]) {
      expect(parseGithub(data, ctx).planned).toEqual(
        ctx === other
          ? { "future-b": false, "future-a": true }
          : ctx === empty
            ? {}
            : { storage: false, indexer: true, search: false },
      );
    }
  });
});

describe("parsers", () => {
  test("every cron line in a workflow file is a schedule", () => {
    expect(
      parseCrons(
        "on:\n  schedule:\n    # comment\n    - cron: \"0 4 * * 1-5\"\n    - cron: '30 8 * * *'\n",
      ),
    ).toEqual(["0 4 * * 1-5", "30 8 * * *"]);
    expect(parseCrons(undefined)).toEqual([]);
  });

  test("the halt line follows the ### Halt heading", () => {
    const body =
      "The upstream filter halted rather than guess.\n\n### Halt\nUNKNOWN_TOP_LEVEL: unclassified top-level entries: schemathesis-tests\n\nA halt usually means...";
    expect(parseHalt(body)).toBe(
      "UNKNOWN_TOP_LEVEL: unclassified top-level entries: schemathesis-tests",
    );
    expect(parseHalt("no heading here")).toBeUndefined();
  });

  test("the declaration yields version, location, profile and trusted forks", () => {
    const text =
      "env: shared\nstackVersion: v0.28.1\nprofile: core\nlocation: westus3\nforks:\n  - service: partition\n    repo: Azure/osdu-spi-partition\n  - service: legal\n    repo: Azure/osdu-spi-legal\n";
    expect(parseDeclaration(text)).toEqual({
      stackVersion: "v0.28.1",
      location: "westus3",
      profile: "core",
      forks: ["partition", "legal"],
    });
  });

  test("the newest Upstream-Sha trailer on fork_upstream is what the fork synced", () => {
    expect(
      parseUpstreamSha([
        {
          oid: "a",
          message: "Merge pull request #165 from Azure/sync/upstream-x",
          committedDate: "2026-09-30T01:32:32Z",
        },
        {
          oid: "b",
          message:
            "chore: generate filtered upstream tree\n\nUpstream-Sha: e3fa53b26e86140221eb1b621e92cdd0ac75df49\nFilter-Rev: 1.0.0+b4950c8de368",
          committedDate: "2026-09-30T00:36:13Z",
        },
      ]),
    ).toEqual({ sha: "e3fa53b26e86140221eb1b621e92cdd0ac75df49", at: "2026-09-30T00:36:13Z" });
  });
});

describe("open work", () => {
  test("a repository read reports authors' association, app authors and open totals", () => {
    const fact = parseRepo({
      nameWithOwner: STACK_REPO,
      url: "https://github.com/Azure/osdu-spi-stack",
      pullRequests: {
        totalCount: 41,
        nodes: [
          {
            number: 323,
            title: "feat: onboard Seismic Store V3",
            url: "u",
            createdAt: "2026-10-08T00:00:00Z",
            updatedAt: "2026-10-08T00:00:00Z",
            isDraft: false,
            headRefName: "feat/add-seismic-service",
            baseRefName: "main",
            headRefOid: "a".repeat(40),
            author: { login: "outside-a" },
            authorAssociation: "CONTRIBUTOR",
          },
        ],
      },
      issues: {
        totalCount: 1,
        nodes: [
          {
            number: 47,
            title: "Upstream Sync Failed",
            url: "u",
            createdAt: "2026-10-08T00:00:00Z",
            updatedAt: "2026-10-08T00:00:00Z",
            author: { __typename: "Bot", login: "osdu-spi-automation" },
            authorAssociation: "NONE",
          },
        ],
      },
    });
    expect(fact.prs[0]?.association).toBe("CONTRIBUTOR");
    expect(fact.issues[0]).toMatchObject({ author: "osdu-spi-automation", bot: true });
    expect(fact.openPrs).toBe(41);
    expect(fact.openIssues).toBe(1);
    expect(buildWork({ [STACK_REPO]: fact }, context).stack.unreadPrs).toBe(40);
  });
  test("a pull request carries its head commit's time only when the last commit read is the head", () => {
    const pr = (oid: string) => ({
      number: 7,
      title: "Sync",
      url: "u",
      createdAt: "2026-10-08T00:00:00Z",
      updatedAt: "2026-10-09T00:00:00Z",
      isDraft: false,
      headRefName: "sync/upstream-20261008-000000",
      baseRefName: "fork_upstream",
      headRefOid: "a".repeat(40),
      commits: { nodes: [{ commit: { oid, committedDate: "2026-10-08T00:05:00Z" } }] },
    });
    const read = (oid: string) =>
      parseRepo({ nameWithOwner: STACK_REPO, url: "u", pullRequests: { nodes: [pr(oid)] } }).prs[0];
    expect(read("a".repeat(40))?.headAt).toBe("2026-10-08T00:05:00Z");
    expect(read("b".repeat(40))).not.toHaveProperty("headAt");
  });
});
