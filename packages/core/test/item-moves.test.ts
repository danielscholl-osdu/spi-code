// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { linkKind } from "../src/brief/move";
import { sweep1116Facts, sweep1116Items, sweep1116Model } from "./sweep-1116";

const RED = ["indexer-queue", "legal", "entitlements", "schema", "indexer"].map(
  (f) => `gate2:${f}`,
);

describe("the 16 Nov sweep", () => {
  const items = sweep1116Items();
  const byId = new Map(items.map((i) => [i.id, i]));

  test("core reads the 23 items on the 16 Nov sweep, in order", () => {
    expect(items.map((i) => [i.id, i.verb])).toEqual([
      ["halt:crs-conversion", "Classify entry"],
      ["sync-run:search", "Investigate"],
      ["sync-run:indexer", "Investigate"],
      ["rollout", "Dispatch"],
      ["stack:lanes", "Re-run lanes"],
      ["gate2:storage", "Investigate"],
      ["lane-deploy:partition", "Investigate"],
      ["radar:workflow", "Absorb toolchain"],
      ["radar:search", "Absorb toolchain"],
      ["radar:unit", "Absorb toolchain"],
      ["radar:crs-catalog", "Absorb toolchain"],
      ["gate1:workflow", "Review on GitHub"],
      ["gate1:crs-conversion", "Review on GitHub"],
      ["gate1:search", "Review on GitHub"],
      ["gate1:unit", "Review on GitHub"],
      ["gate1:crs-catalog", "Review on GitHub"],
      ["gate2:indexer-queue", "Merge"],
      ["gate2:search", "Merge"],
      ["gate2:legal", "Merge"],
      ["gate2:partition", "Merge"],
      ["gate2:entitlements", "Merge"],
      ["gate2:schema", "Merge"],
      ["gate2:indexer", "Merge"],
    ]);
  });

  test("every item's next move is the operator's", () => {
    expect(items.filter((i) => i.actor !== "operator").map((i) => i.id)).toEqual([]);
  });

  test("a rollout is the system's while the environment holds it or nothing waits for review", () => {
    const actor = (next: "env" | "wait" | "dispatch" | "start", reviews: boolean, room = 5) => {
      const model = sweep1116Model();
      if (!model.rollout) throw new Error("16 Nov has a rollout");
      model.rollout.phase = next === "start" ? "ready" : model.rollout.phase;
      model.rollout.next = next;
      model.rollout.reviews = reviews ? model.rollout.forks.slice(0, 1) : [];
      model.rollout.lanes.room = room;
      model.rollout.dispatchNext = room > 0 ? model.rollout.forks.slice(0, room) : [];
      return sweep1116Items(model).find((i) => i.id === "rollout")?.actor;
    };
    expect(actor("env", true)).toBe("system");
    expect(actor("wait", false)).toBe("system");
    expect(actor("wait", true)).toBe("operator");
    expect(actor("dispatch", false)).toBe("operator");
    expect(actor("start", false)).toBe("operator");
    expect(actor("start", false, 0)).toBe("system");
  });

  test("a toolchain move and the sync PR that carries it share one subject; no other items do", () => {
    const shared = new Map<string, string[]>();
    for (const i of items) {
      if (i.subject) shared.set(i.subject, [...(shared.get(i.subject) ?? []), i.id]);
    }
    expect([...shared].filter(([, ids]) => ids.length > 1)).toEqual([
      ["https://github.com/Azure/osdu-spi-workflow/pull/60", ["radar:workflow", "gate1:workflow"]],
      ["https://github.com/Azure/osdu-spi-search/pull/77", ["radar:search", "gate1:search"]],
      ["https://github.com/Azure/osdu-spi-unit/pull/50", ["radar:unit", "gate1:unit"]],
      [
        "https://github.com/Azure/osdu-spi-crs-catalog/pull/54",
        ["radar:crs-catalog", "gate1:crs-catalog"],
      ],
    ]);
  });

  test("a move on several objects names no subject", () => {
    expect(items.filter((i) => !i.subject).map((i) => i.id)).toEqual([
      "rollout",
      "stack:lanes",
    ]);
  });

  test("each red release/upstream PR waits on the lanes item that folded its failed lane", () => {
    expect(items.filter((i) => i.blockedBy).map((i) => [i.id, i.blockedBy])).toEqual(
      RED.map((id) => [id, "stack:lanes"]),
    );
  });

  test("a red PR whose lanes item is not in the sweep names no blocker", () => {
    const model = sweep1116Model();
    const lanes = model.queue.items.find((i) => i.id === "stack:lanes");
    if (!lanes?.fingerprint) throw new Error("16 Nov holds the lanes item");
    const dismissed = sweep1116Items(
      sweep1116Model(sweep1116Facts(), [{ id: lanes.id, fingerprint: lanes.fingerprint }]),
    );
    expect(dismissed.map((i) => i.id)).toEqual(expect.arrayContaining(RED));
    expect(dismissed.some((i) => i.id === "stack:lanes")).toBe(false);
    expect(dismissed.filter((i) => i.blockedBy)).toEqual([]);
  });

  test("the failed sync names the halt issue the sync engine opened on its fork", () => {
    const item = byId.get("sync-run:indexer");
    expect(item).toMatchObject({
      title: "Sync Upstream failed with halt issue #72 open",
      next: "Read halt issue #72, then open the failed Sync Upstream run.",
      subject: "https://github.com/Azure/osdu-spi-indexer/issues/72",
    });
    expect(item?.evidence).toEqual([
      {
        label: "issue #72",
        url: "https://github.com/Azure/osdu-spi-indexer/issues/72",
        kind: "issue",
      },
      {
        label: "run Sync Upstream 00:32",
        url: "https://github.com/Azure/osdu-spi-indexer/actions/runs/43988443150",
        kind: "run",
      },
    ]);
  });

  test("with no halt issue open the failed sync says so", () => {
    const facts = sweep1116Facts();
    const repo = facts.github.data?.repos["Azure/osdu-spi-indexer"];
    if (!repo) throw new Error("16 Nov read indexer");
    repo.issues = repo.issues.filter((i) => i.number !== 72);
    const item = sweep1116Items(sweep1116Model(facts)).find((i) => i.id === "sync-run:indexer");
    expect(item).toMatchObject({
      title: "Sync Upstream failed with no halt issue open",
      next: "Open the failed Sync Upstream run; no halt issue says why it stopped.",
      subject: "https://github.com/Azure/osdu-spi-indexer/actions/runs/43988443150",
    });
    expect(item?.evidence.map((l) => l.kind)).toEqual(["run"]);
  });

  test("every evidence link carries the kind its URL names", () => {
    expect(items.flatMap((i) => i.evidence).filter((l) => l.kind !== linkKind(l.url))).toEqual([]);
    expect(new Set(items.flatMap((i) => i.evidence.map((l) => l.kind)))).toEqual(
      new Set(["issue", "run", "commit", "compare", "job", "pr", "other", "deploy"]),
    );
  });
});

describe("a link's kind", () => {
  const GH = "https://github.com/Azure/osdu-spi-legal";
  const GL = "https://community.opengroup.org/osdu/platform/security-and-compliance/entitlements";
  test.each([
    [`${GH}/pull/90`, "pr"],
    [`${GH}/issues/72`, "issue"],
    [`${GH}/actions/runs/43988443150`, "run"],
    [`${GH}/actions/runs/43988443150/attempts/2`, "run"],
    [`${GH}/actions/runs/43985202145/job/133716436041`, "job"],
    [`${GH}/commit/9bea4ff20266108d0f0f83dd9e01f8595d34dae5`, "commit"],
    [
      "https://github.com/Azure/osdu-spi/compare/d3ddff562b24cf3b259c8a215fd8b7962df1eb97...1a4730d327268b5c2a57257fb7289738d4357b0a",
      "compare",
    ],
    [`${GH}/deployments`, "deploy"],
    [`${GL}/-/merge_requests/968`, "mr"],
    [`${GL}/-/commit/0cab109017b316cfd6a037c6c603ad4ee293f3c1`, "commit"],
    [`${GL}/-/issues/12`, "issue"],
    [`${GL}/-/pipelines/301`, "run"],
    [`${GL}/-/jobs/4417`, "job"],
    [`${GL}/-/compare/0cab109017b316cfd6a037c6c603ad4ee293f3c1...main`, "compare"],
    [`${GH}/pull/90?notification=1#issuecomment-1`, "pr"],
  ])("%s is a %s", (url, kind) => {
    expect(linkKind(url)).toBe(kind);
  });

  test.each([
    GH,
    `${GH}/pulls`,
    `${GH}/pull/90/files`,
    `${GH}/issues`,
    `${GH}/actions?query=is%3Aaction_required`,
    `${GH}/blob/main/.github/upstream-filter.yml`,
    `${GH}/commit/main`,
    `${GH}/releases/tag/v1.2.1`,
    "https://github.com/Azure/osdu-spi/security/code-scanning/72",
    `${GL}/-/tree/main`,
    `${GL}/merge_requests/968`,
    "https://example.test/pull/90",
    "https://example.test/repo/-/merge_requests/12",
    "https://example.test/repo/-/commit/abcdef1234567",
    "ftp://github.com/Azure/osdu-spi-legal/pull/90",
    "not a url",
    "",
  ])("%s is of no known shape, so other", (url) => {
    expect(linkKind(url)).toBe("other");
  });
});
