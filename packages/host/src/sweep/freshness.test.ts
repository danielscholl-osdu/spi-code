// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AREAS,
  createContext,
  type Exec,
  factsSchema,
  fleetOf,
  RecordingExec,
  ReplayExec,
  SWEEP_MS,
} from "@spi-code/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openRunStore } from "../store/store.js";
import { SweepService } from "./service.js";

const START = "2026-10-14T00:00:00.000Z";
const REPO = "owner/partition";
let directory: string;
const databases: DatabaseSync[] = [];
const services: SweepService[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(START));
  directory = mkdtempSync(join(tmpdir(), "spi-freshness-"));
});

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  for (const db of databases.splice(0)) db.close();
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});

function service(exec: Exec, name: string) {
  const path = join(directory, `${name}.sqlite`);
  openRunStore(path).close();
  const db = new DatabaseSync(path);
  databases.push(db);
  const instance = new SweepService({
    db,
    fleet: name,
    appData: directory,
    ctx: createContext({
      fleet: {
        ...fleetOf([{ id: "partition", repo: REPO, upstream: "osdu/partition" }]),
        planned: [],
      },
      clock: { now: () => new Date(Date.now()) },
    }),
    exec,
    factsSchema,
    ttlMs: 2 * 60 * 60_000,
    doctor: () => ({ state: "clear", problems: [] }),
    timers: { after: () => () => {} },
    onError: (error) => {
      throw error;
    },
  });
  services.push(instance);
  return instance;
}

function recording() {
  let remaining = 4000;
  let githubOffline = false;
  let cutJobs = false;
  const log: string[] = [];
  const unexpected: string[] = [];
  const run = {
    id: 5,
    name: "Run",
    path: "workflow.yml",
    event: "push",
    status: "completed",
    conclusion: "success",
    created_at: START,
    updated_at: START,
    head_branch: "main",
    head_sha: "head",
    display_title: "Upgrade shared environment",
    html_url: "https://github.com/Azure/osdu-spi-stack/actions/runs/5",
    run_attempt: 1,
  };
  const exec = new RecordingExec(
    async (cmd, args) => {
      const path = args.find((arg) => /^(repos|projects|groups)\//.test(arg)) ?? "";
      const query = args.find((arg) => arg.startsWith("query=")) ?? "";
      let data: unknown;
      if (cmd === "gh" && query) {
        let payload: object;
        if (/(?:\s|\{)stack: repository/.test(query)) {
          payload = {
            stack: { object: { text: `forks:\n  - service: partition\n    repo: ${REPO}\n` } },
            template: { object: null },
          };
        } else if (query.includes("r_template:") || query.includes("r_fork0:")) {
          const repo = (nameWithOwner: string) => ({
            nameWithOwner,
            url: `https://github.com/${nameWithOwner}`,
            defaultBranchRef: { target: { oid: "head", committedDate: START } },
            marker: { text: "head" },
            ...(nameWithOwner === REPO
              ? {
                  pullRequests: {
                    totalCount: 1,
                    nodes: [
                      {
                        number: 1,
                        title: "Test change",
                        url: `https://github.com/${REPO}/pull/1`,
                        createdAt: START,
                        updatedAt: START,
                        isDraft: false,
                        headRefName: "change",
                        baseRefName: "main",
                        headRefOid: "pr-head",
                        commits: {
                          nodes: [
                            {
                              commit: {
                                statusCheckRollup: {
                                  contexts: {
                                    nodes: [
                                      {
                                        __typename: "CheckRun",
                                        databaseId: 9,
                                        name: "Unit tests",
                                        status: "COMPLETED",
                                        conclusion: "FAILURE",
                                        checkSuite: {
                                          workflowRun: {
                                            databaseId: 10,
                                            workflow: { name: "Validate" },
                                          },
                                        },
                                      },
                                    ],
                                  },
                                },
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                }
              : {}),
          });
          if (githubOffline) return { stdout: "", stderr: "fixture GitHub unavailable", exit: 1 };
          payload = query.includes("r_template:")
            ? {
                r_template: repo("Azure/osdu-spi"),
                r_stack: repo("Azure/osdu-spi-stack"),
                ...Object.fromEntries(
                  [...query.matchAll(/(p_\d+): repository/g)].map((match) => [match[1], null]),
                ),
              }
            : { r_fork0: repo(REPO) };
        } else if (query.includes("port_o0")) {
          payload = Object.fromEntries(
            ["port_o0", "port_m0"].map((key) => [
              key,
              { issueCount: 0, nodes: [], pageInfo: { hasNextPage: false } },
            ]),
          );
        } else if (query.includes("pom0:")) {
          payload = { pom0: { root: { oid: "blob" } } };
        } else if (query.includes("createdAt")) {
          payload = Object.fromEntries(
            ["r0", "r1", "r2", "r3"].map((key) => [key, { createdAt: START }]),
          );
        } else {
          payload = { repository: { p0: { text: "<java.version>21</java.version>" } } };
        }
        data = {
          data: {
            ...payload,
            spicodeBudget: {
              cost: 2,
              remaining,
              resetAt: new Date(
                Math.floor(Date.now() / 3600_000) * 3600_000 + 3600_000,
              ).toISOString(),
            },
          },
        };
      } else if (cmd === "glab" && query) {
        data = { data: { p0: { mergeRequests: { nodes: [], pageInfo: { hasNextPage: false } } } } };
      } else if (args.includes("status") || args[1] === "user") {
        return { stdout: "", stderr: "", exit: 0 };
      } else if (path.endsWith("actions/variables?per_page=100&page=1")) {
        data = { total_count: 0, variables: [] };
      } else if (path.includes("/attempts/")) {
        data = { total: cutJobs ? 1 : 0, jobs: [] };
      } else if (path.includes("/check-runs/") || path.endsWith("/logs")) {
        return { stdout: "", stderr: "", exit: 0 };
      } else if (path.includes("/actions/jobs/")) {
        data = {
          id: 9,
          name: "Unit tests",
          status: "completed",
          conclusion: "failure",
          started_at: START,
          completed_at: START,
          html_url: `https://github.com/${REPO}/actions/jobs/9`,
          steps: [],
          run_attempt: 1,
        };
      } else if (
        path.includes("/workflows/validate.yml/") ||
        path.includes("/workflows/env-upgrade.yml/")
      ) {
        data = { total: 1, runs: [run] };
      } else if (path.includes("/actions/")) {
        data = { total: 0, runs: [] };
      } else if (path.includes("/compare/")) {
        data = { status: "identical", ahead_by: 0, behind_by: 0, total_commits: 0, commits: [] };
      } else if (path.includes("sync-config.json")) {
        data = { dirs: [], files: [] };
      } else if (path.includes("/contents/ops/environments/shared.yaml?ref=")) {
        data = { text: "stackVersion: v1.0.0\n" };
      } else if (path.includes("/releases?")) {
        data = { tag: "v1.0.0", at: START, body: "" };
      } else if (path.includes("/git/matching-refs/tags/")) {
        data = { tag: "v1.0.0", sha: "a".repeat(40) };
      } else if (path.includes("/git/trees/")) {
        data = { paths: [], truncated: false };
      } else if (path.includes("/git/blobs/")) {
        data = {
          content: Buffer.from("<os-core-common.version>1.0.0</os-core-common.version>").toString(
            "base64",
          ),
        };
      } else if (path.includes("upstream-filter.yml")) {
        data = {
          sha: "filter",
          content: Buffer.from("top_level:\n  docs: shared\n").toString("base64"),
        };
      } else if (path.includes("/repository/branches/")) {
        data = { commit: { id: "head", committed_date: START } };
      } else if (path.includes("/repository/files/")) {
        data = { content: Buffer.from("<project/>").toString("base64") };
      } else if (path.includes("/repository/tags")) {
        data = [{ name: "v1.0.0" }];
      } else if (cmd === "glab") {
        data = [];
      } else if (path.includes("/dependabot/") || path.includes("/code-scanning/")) {
        return { stdout: "", stderr: "", exit: 0 };
      } else {
        unexpected.push(`${cmd} ${args.join(" ")}`);
        return { stdout: "", stderr: "unhandled fixture read", exit: 1 };
      }
      return { stdout: JSON.stringify(data), stderr: "", exit: 0 };
    },
    (line) => {
      log.push(line);
    },
  );
  return {
    exec,
    log,
    unexpected,
    setBudget: (value: number) => {
      remaining = value;
    },
    failGithub: () => {
      githubOffline = true;
    },
    cutJobs: () => {
      cutJobs = true;
    },
  };
}

async function fiveSweeps(exec: Exec, name: string) {
  vi.setSystemTime(new Date(START));
  const instance = service(exec, name);
  await instance.start();
  for (let sweep = 0; sweep < 5; sweep++) {
    if (sweep) {
      vi.setSystemTime(Date.parse(START) + (sweep + 2) * SWEEP_MS);
      await instance.sweep();
    }
    expect(instance.latest()?.reads.filter((read) => read.failure)).toEqual([]);
    expect(instance.latest()?.areas.map(({ area, envelope }) => [area, envelope.state])).toEqual(
      AREAS.map((area) => [area, "fresh"]),
    );
    expect(instance.latest()?.tree.find(({ id }) => id === "environment")?.status).toBe("fresh");
    if (sweep) {
      for (const area of ["runs", "lifecycle", "details", "template"]) {
        expect(
          instance.latest()?.areas.find((entry) => entry.area === area)?.envelope,
        ).toMatchObject({ observedAt: new Date(Date.now()).toISOString() });
      }
      expect(instance.latest()?.reads).toContainEqual(
        expect.objectContaining({
          object: `repos/${REPO}/actions/jobs/9`,
          observedAt: START,
        }),
      );
    }
  }
  await instance.stop();
}

it("keeps every area fresh across recorded sweeps with unchanged cache keys and longer cadences", async () => {
  const fixture = recording();
  await fiveSweeps(fixture.exec, "record");
  expect(fixture.unexpected).toEqual([]);
  const replay = new ReplayExec(fixture.log.join(""));
  await fiveSweeps(replay, "replay");
  replay.assertExhausted();
});

it("exposes a due area's budget skip reason without refreshing its last good observation", async () => {
  const fixture = recording();
  const instance = service(fixture.exec, "skip");
  await instance.start();
  fixture.setBudget(50);
  vi.setSystemTime(Date.parse(START) + 35 * 60_000);
  await instance.sweep();
  expect(fixture.unexpected).toEqual([]);
  expect(instance.latest()?.reads).toContainEqual(
    expect.objectContaining({
      source: "security",
      object: "security",
      failure: "Read deferred: insufficient budget",
      retainedFrom: START,
    }),
  );
  expect(instance.latest()?.areas.find(({ area }) => area === "security")?.envelope).toMatchObject({
    state: "failed",
    observedAt: START,
  });
  fixture.setBudget(4000);
  vi.setSystemTime(Date.parse(START) + 65 * 60_000);
  await instance.sweep();
  expect(instance.latest()?.areas.find(({ area }) => area === "security")?.envelope).toMatchObject({
    state: "fresh",
    observedAt: new Date(Date.now()).toISOString(),
  });
  expect(
    instance.latest()?.reads.filter((read) => read.failure?.startsWith("Read deferred:")),
  ).toEqual([]);
});

it("does not confirm cached template or detail reads from failed GitHub selectors, or stop later areas", async () => {
  const fixture = recording();
  const instance = service(fixture.exec, "failed");
  await instance.start();
  fixture.failGithub();
  vi.setSystemTime(Date.parse(START) + 3 * SWEEP_MS);
  await instance.sweep();
  expect(fixture.unexpected).toEqual([]);
  const areas = new Map(instance.latest()?.areas.map(({ area, envelope }) => [area, envelope]));
  expect(areas.get("github")?.state).toBe("failed");
  expect(areas.get("template")?.state).toBe("stale");
  expect(areas.get("details")?.state).toBe("stale");
  expect(areas.get("runs")?.state).toBe("fresh");
  expect(areas.get("lifecycle")?.state).toBe("fresh");
});

it("keeps a cut job listing incomplete on subsequent successful area reads", async () => {
  const fixture = recording();
  fixture.cutJobs();
  const instance = service(fixture.exec, "cut");
  await instance.start();
  vi.setSystemTime(Date.parse(START) + 3 * SWEEP_MS);
  await instance.sweep();
  expect(fixture.unexpected).toEqual([]);
  for (const area of ["runs", "lifecycle"]) {
    expect(instance.latest()?.areas.find((entry) => entry.area === area)?.envelope).toMatchObject({
      state: "incomplete",
      completeness: { kind: "cut" },
    });
  }
});
