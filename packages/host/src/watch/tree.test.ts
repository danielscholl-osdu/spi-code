// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type AreaName, type ReadRecord, TEMPLATE_REPO } from "@spi-code/core";
import { describe, expect, it } from "vitest";
import { projectWatch } from "./project.js";
import { fixtureInput } from "./snapshot-fixture.js";
import { treeOf } from "./tree.js";

process.env.TZ = "UTC";

describe("Watch projection", () => {
  it("uses the injected clock for fresh, stale, incomplete and unread tree dots", () => {
    const fixture = fixtureInput();
    const record: ReadRecord = {
      source: "GitHub",
      object: "repositories",
      observedAt: fixture.context.clock.now().toISOString(),
      completeness: { kind: "complete" },
    };
    let input = { ...fixture, reads: { github: [record] } };
    expect(projectWatch(input).tree.find(({ id }) => id === "repositories")?.status).toBe("fresh");
    const stale = { ...record, observedAt: "2026-10-20T15:00:00.000Z" };
    input = { ...input, intervalMs: 0, reads: { github: [stale] } };
    expect(projectWatch(input).tree.find(({ id }) => id === "repositories")?.status).toBe("stale");
    input = {
      ...input,
      reads: {
        github: [
          {
            ...stale,
            completeness: { kind: "cut", reason: "limit", read: 1, total: 2 },
          },
        ],
      },
    };
    expect(projectWatch(input).tree.find(({ id }) => id === "repositories")?.status).toBe(
      "incomplete",
    );
    expect(projectWatch(input).tree.find(({ id }) => id === "setup")?.status).toBe("unread");
  });

  it("uses a service's GitLab provenance without borrowing another service's failure", () => {
    const input = fixtureInput();
    const fork = input.context.fleet.forks[0];
    if (!fork) throw new Error("Pinned fixture must include a service");
    const at = input.context.clock.now().toISOString();
    input.reads.upstream = [
      {
        source: fork.upstream,
        object: "compare",
        observedAt: at,
        completeness: { kind: "cut", reason: "page limit", read: 1, total: 2 },
      },
      {
        source: "another/project",
        object: "compare",
        observedAt: at,
        completeness: { kind: "complete" },
        failure: "offline",
      },
    ];
    expect(projectWatch(input).tree.find(({ id }) => id === `service:${fork.id}`)?.status).toBe(
      "incomplete",
    );
  });

  it("isolates approval run evidence by repository", () => {
    const input = fixtureInput();
    const run = Object.values(input.facts.approvals.data ?? {}).flat()[0];
    if (!run) throw new Error("Pinned fixture must include an approval run");
    const at = input.context.clock.now().toISOString();
    input.facts.approvals.data = {
      "Azure/healthy": [{ ...run, id: 1001 }],
      "Azure/failed": [{ ...run, id: 1002 }],
    };
    input.reads.approvals = [
      {
        source: "Azure/healthy",
        object: "approvals",
        observedAt: at,
        completeness: { kind: "complete" },
      },
      {
        source: "Azure/failed",
        object: "approvals",
        observedAt: at,
        completeness: { kind: "complete" },
        failure: "offline",
      },
    ];
    const tree = treeOf(input, input.context.clock.now());
    expect(tree.find(({ id }) => id === "run:1001")?.status).toBe("fresh");
    expect(tree.find(({ id }) => id === "run:1002")?.status).toBe("failed");
  });

  it.each(["repository source", "GitHub API path"])(
    "isolates lifecycle run evidence by %s",
    (scope) => {
      const input = fixtureInput();
      const run = input.facts.lifecycle.data?.refresh[0];
      if (!run) throw new Error("Pinned fixture must include a lifecycle run");
      const at = input.context.clock.now().toISOString();
      input.facts.lifecycle.data = {
        refresh: [
          { ...run, id: 1003, url: "https://github.com/Azure/healthy/actions/runs/1003" },
          { ...run, id: 1004, url: "https://github.com/Azure/failed/actions/runs/1004" },
        ],
        upgrade: [],
        smoke: [],
        sweeper: [],
      };
      input.reads.lifecycle = ["healthy", "failed"].map((repo) => ({
        source: scope === "repository source" ? `Azure/${repo}` : "github",
        object: scope === "repository source" ? "lifecycle" : `repos/Azure/${repo}/actions/runs`,
        observedAt: at,
        completeness: { kind: "complete" },
        ...(repo === "failed" ? { failure: "offline" } : {}),
      }));
      const { tree } = projectWatch(input);
      expect(tree.find(({ id }) => id === "run:1003")?.status).toBe("fresh");
      expect(tree.find(({ id }) => id === "run:1004")?.status).toBe("failed");
    },
  );

  it("includes failed release evidence in System and Today", () => {
    const input = fixtureInput();
    const record: ReadRecord = {
      source: "github",
      object: "github",
      observedAt: input.context.clock.now().toISOString(),
      completeness: { kind: "complete" },
    };
    const { tree } = projectWatch({
      ...input,
      reads: { github: [record] },
      releaseRecords: [{ ...record, source: "releases", object: "releases", failure: "offline" }],
    });
    for (const id of ["today", "system", "releases"]) {
      expect(tree.find((node) => node.id === id)?.status).toBe("failed");
    }
  });

  it("includes shared template dependency failures in every service dot", () => {
    const input = fixtureInput();
    const at = input.context.clock.now().toISOString();
    input.reads.github = input.context.fleet.forks.map((fork) => ({
      source: fork.repo,
      object: "repository",
      observedAt: at,
      completeness: { kind: "complete" },
    }));
    input.reads.template = [
      {
        source: TEMPLATE_REPO,
        object: `repos/${TEMPLATE_REPO}/contents/.github/sync-config.json`,
        observedAt: at,
        completeness: { kind: "complete" },
        failure: "offline",
      },
    ];
    const services = projectWatch(input).tree.filter(({ id }) => id.startsWith("service:"));
    expect(services.map(({ status }) => status)).toEqual(
      input.context.fleet.forks.map(() => "failed"),
    );
  });

  it.each(["github", "runs", "upstream", "radar", "template"] as const)(
    "includes an area-wide %s failure in a service dot",
    (area) => {
      const input = fixtureInput();
      const fork = input.context.fleet.forks[0];
      if (!fork) throw new Error("Pinned fixture must include a service");
      const at = input.context.clock.now().toISOString();
      const own: ReadRecord = {
        source: fork.repo,
        object: "repository",
        observedAt: at,
        completeness: { kind: "complete" },
      };
      input.reads.github = [own];
      input.reads[area] = [
        ...(input.reads[area] ?? []),
        {
          source: area,
          object: area,
          observedAt: at,
          completeness: { kind: "complete" },
          failure: "offline",
        },
      ];
      expect(projectWatch(input).tree.find(({ id }) => id === `service:${fork.id}`)?.status).toBe(
        "failed",
      );
    },
  );

  it.each(["fork", "stack", "area"] as const)(
    "scopes a failed GitHub %s read using the collector's object identity",
    (scope) => {
      const input = fixtureInput();
      const fork = input.context.fleet.forks[0];
      if (!fork) throw new Error("Pinned fixture must include a service");
      const at = input.context.clock.now().toISOString();
      const failedObject =
        scope === "fork" ? fork.repo : scope === "stack" ? "Azure/osdu-spi-stack" : "github";
      const github: ReadRecord[] = input.context.fleet.forks.map((service) => ({
        source: "github",
        object: service.repo,
        observedAt: at,
        completeness: { kind: "complete" },
        ...(service.repo === failedObject ? { failure: "offline" } : {}),
      }));
      if (scope !== "fork") {
        github.push({
          source: "github",
          object: failedObject,
          observedAt: at,
          completeness: { kind: "complete" },
          failure: "offline",
        });
      }
      const { tree } = projectWatch({ ...input, reads: { github } });
      for (const service of input.context.fleet.forks) {
        expect(tree.find(({ id }) => id === `service:${service.id}`)?.status).toBe(
          scope === "area" || service.repo === failedObject ? "failed" : "fresh",
        );
      }
    },
  );

  it.each(["fresh", "stale", "incomplete", "failed"] as const)(
    "keeps services without their own evidence unread despite a %s shared template read",
    (state) => {
      const input = fixtureInput();
      const now = input.context.clock.now();
      const template: ReadRecord = {
        source: TEMPLATE_REPO,
        object: "sync-config",
        observedAt:
          state === "stale"
            ? new Date(now.getTime() - 3 * input.intervalMs).toISOString()
            : now.toISOString(),
        completeness:
          state === "incomplete"
            ? { kind: "cut", reason: "Template commit page limit", read: 100, total: 250 }
            : { kind: "complete" },
        ...(state === "failed" ? { failure: "offline" } : {}),
      };
      const services = projectWatch({ ...input, reads: { template: [template] } }).tree.filter(
        ({ id }) => id.startsWith("service:"),
      );
      expect(services.map(({ status }) => status)).toEqual(
        input.context.fleet.forks.map(() => "unread"),
      );
    },
  );

  it.each(["fresh", "stale", "incomplete", "failed"] as const)(
    "uses a %s shared template read only to degrade a service with its own evidence",
    (state) => {
      const input = fixtureInput();
      const fork = input.context.fleet.forks[0];
      if (!fork) throw new Error("Pinned fixture must include a service");
      const now = input.context.clock.now();
      const template: ReadRecord = {
        source: TEMPLATE_REPO,
        object: "sync-config",
        observedAt:
          state === "stale"
            ? new Date(now.getTime() - 3 * input.intervalMs).toISOString()
            : now.toISOString(),
        completeness:
          state === "incomplete"
            ? { kind: "cut", reason: "Template commit page limit", read: 100, total: 250 }
            : { kind: "complete" },
        ...(state === "failed" ? { failure: "offline" } : {}),
      };
      const { tree } = projectWatch({
        ...input,
        reads: {
          github: [
            {
              source: "github",
              object: fork.repo,
              observedAt: now.toISOString(),
              completeness: { kind: "complete" },
            },
          ],
          template: [template],
        },
      });
      expect(tree.find(({ id }) => id === `service:${fork.id}`)?.status).toBe(state);
    },
  );

  it.each([false, true])(
    "applies a whole-area fork-runs record to run dots (failed: %s)",
    (failed) => {
      const input = fixtureInput();
      const run = input.facts.lifecycle.data?.refresh[0];
      if (!run) throw new Error("Pinned fixture must include a run");
      input.facts.runs.data = {
        "Azure/example": { sync: [{ ...run, id: 2001 }], template: [], cascade: [], main: [] },
      };
      input.reads.runs = [
        {
          source: "runs",
          object: "runs",
          observedAt: input.context.clock.now().toISOString(),
          completeness: { kind: "complete" },
          ...(failed ? { failure: "offline" } : {}),
        },
      ];
      expect(projectWatch(input).tree.find(({ id }) => id === "run:2001")?.status).toBe(
        failed ? "failed" : "fresh",
      );
    },
  );
});

describe("area envelopes and provenance", () => {
  it("judges each tree dot's records against their own area's sweep interval", () => {
    const input = fixtureInput();
    const start = input.context.clock.now().getTime();
    let now = start;
    const context = { ...input.context, clock: { now: () => new Date(now) } };
    const read = (area: string): ReadRecord => ({
      source: area,
      object: area,
      observedAt: new Date(start).toISOString(),
      completeness: { kind: "complete" },
    });
    const at = (ms: number, intervals?: Partial<Record<AreaName, number>>) => {
      now = start + ms;
      const { tree } = projectWatch({
        ...input,
        context,
        intervalMs: 600_000,
        ...(intervals === undefined ? {} : { intervals }),
        reads: { runs: [read("runs")], github: [read("github")] },
      });
      return Object.fromEntries(
        tree
          .filter(({ id }) => ["runs", "repositories", "services"].includes(id))
          .map(({ id, status }) => [id, status]),
      );
    };
    const perArea = { runs: 60_000 };
    expect(at(0, perArea)).toEqual({ runs: "fresh", repositories: "fresh", services: "fresh" });
    expect(at(120_000, perArea)).toEqual({
      runs: "fresh",
      repositories: "fresh",
      services: "fresh",
    });
    expect(at(120_001, perArea)).toEqual({
      runs: "stale",
      repositories: "fresh",
      services: "stale",
    });
    expect(at(120_001)).toEqual({ runs: "fresh", repositories: "fresh", services: "fresh" });
    expect(at(1_200_000, perArea)).toMatchObject({ repositories: "fresh" });
    expect(at(1_200_001, perArea)).toMatchObject({ repositories: "stale" });
    expect(at(1_200_001)).toEqual({ runs: "stale", repositories: "stale", services: "stale" });
  });
});
