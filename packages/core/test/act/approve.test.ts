// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { APPROVE_RUNS, approveAction, approveTargets } from "../../src/act/approve.js";
import { bindingSchema } from "../../src/act/verbs.js";
import type { ApprovePr } from "../../src/model/queue.js";

const STACK = "Azure/osdu-spi-stack";
const SWEPT = { item: `approvals:${STACK}`, swept: "2026-10-12T21:58:30Z" };
const approval: ApprovePr = {
  repo: STACK,
  pr: {
    number: 327,
    title: "feat: add RAFS service",
    url: `https://github.com/${STACK}/pull/327`,
    author: "contributor-b",
    association: "FIRST_TIME_CONTRIBUTOR",
    draft: false,
    headSha: "c1c308ae709bd66451a299509b69097888ac5f81",
    files: Array.from({ length: 14 }, (_, i) => `services/rafs/file-${i}.yaml`),
    changedFiles: 41,
    additions: 2271,
    deletions: 81,
  },
  runs: [
    { id: 38268575770, name: "CodeQL" },
    { id: 38268575898, name: "Validate" },
  ],
  since: "2026-10-12T15:12:52Z",
  workflowFiles: [],
};

describe("the approve button", () => {
  test("names the author, the diff and the files, and lists one call per run", () => {
    const button = approveAction(approval, SWEPT);
    expect(button.label).toBe("Approve #327 · 2 runs");
    expect(button.confirm?.irreversible).toBeUndefined();
    const body = button.confirm?.body ?? "";
    expect(body).toContain(
      "#327 feat: add RAFS service, by contributor-b (first-time-contributor) · 41 files · +2271 −81.",
    );
    expect(body).toContain("services/rafs/file-7.yaml, and 33 more.");
    expect(body).not.toContain("file-8.yaml");
    expect(body).toContain(`gh api --method POST repos/${STACK}/actions/runs/38268575770/approve`);
    expect(body).toContain(`gh api --method POST repos/${STACK}/actions/runs/38268575898/approve`);
    expect(bindingSchema.parse(button.binding)).toEqual({
      ...SWEPT,
      verb: APPROVE_RUNS.id,
      targets: approveTargets(approval),
    });
  });

  test("a PR that changes .github/ is approved only after its number is typed", () => {
    const a = {
      ...approval,
      pr: {
        ...approval.pr,
        number: 343,
        title: "fix(k8s): Harden Reference Catalog Downloads",
        author: "contributor-a",
        association: "CONTRIBUTOR",
        headSha: "541ab075615710332d1212659f536d027e6c72c3",
        files: [".github/workflows/validate.yml", "k8s/reference/download.sh"],
        changedFiles: 2,
        additions: 90,
        deletions: 12,
      },
      runs: [
        { id: 38380539981, name: "CodeQL" },
        { id: 38380540082, name: "Validate" },
      ],
      workflowFiles: [".github/workflows/validate.yml"],
    };
    const button = approveAction(a, SWEPT);
    expect(button.confirm).toMatchObject({
      irreversible: true,
      subject: "343",
      label: "Type 343: this PR changes .github/",
    });
    expect(button.confirm?.body).toContain(
      "It changes .github/workflows/validate.yml, and approved runs execute that change.",
    );
    expect(approveTargets(a)).toEqual(
      a.runs.map((r) => ({
        repo: STACK,
        kind: "run",
        number: r.id,
        pr: 343,
        sha: a.pr.headSha,
        state: "action_required",
        label: `#343 ${r.name}`,
      })),
    );
  });

  test("a disabled approval has its reason instead of a confirmation", () => {
    expect(approveAction(approval, SWEPT, "missing repo scope")).toMatchObject({
      disabled: true,
      reason: "missing repo scope",
    });
    expect(approveAction(approval, SWEPT, "missing repo scope").confirm).toBeUndefined();
    const button = approveAction(
      {
        ...approval,
        pr: { ...approval.pr, draft: true, files: ["one.ts"], changedFiles: 1 },
        runs: approval.runs.slice(0, 1),
      },
      SWEPT,
    );
    expect(button.label).toBe("Approve #327 · 1 run");
    expect(button.confirm?.body).toContain("first-time-contributor, draft");
    expect(button.confirm?.body).toContain("Files: one.ts.");
    expect(button.confirm?.body).not.toContain("more.");
  });
});
