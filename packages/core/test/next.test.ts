// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { readItem } from "../src/brief/index";
import { buildModel } from "../src/model/index";
import { CLASS_VERB, itemClass, nextText, verbOf } from "../src/model/next";
import type { QueueItem } from "../src/model/queue";
import { fixtureContext } from "./briefing-setup";
import { FIXTURE_NOW, fixtureFacts } from "./harness";

function item(over: Partial<QueueItem>): QueueItem {
  return {
    id: "x",
    kind: "gate1",
    rung: 1,
    scope: "svc",
    text: "",
    effects: [],
    cause: [],
    incident: false,
    blocks: 1,
    ...over,
  };
}

describe("the class table", () => {
  test("each failure class has its verb", () => {
    expect(CLASS_VERB).toMatchObject({
      HALT: "Classify entry",
      TOOLCHAIN: "Absorb toolchain",
      BUILD: "Investigate",
      TEST: "Investigate",
      ENV: "Re-run lanes",
      ACCESS: "Open run, Open PR",
      CONFLICT: "Investigate, then Dispatch cascade",
    });
  });

  test("one row of each class names its verb and a Next line that says how", () => {
    const rows: [Partial<QueueItem>, string, string, RegExp][] = [
      [
        {
          kind: "halt",
          rung: 0,
          cls: "HALT",
          incident: true,
          halt: {
            fork: "entitlements",
            code: "UNKNOWN_TOP_LEVEL",
            entries: ["schemathesis-tests"],
          },
        },
        "HALT",
        "Classify entry",
        /^Add a rule for schemathesis-tests to \.github\/upstream-filter\.yml, then dispatch sync$/,
      ],
      [
        {
          kind: "gate1",
          cls: "TOOLCHAIN",
          incident: true,
          cause: [
            {
              label: "reason",
              value: "RequireJavaVersion: JDK 17.0.20-1 is outside the allowed range [25,)",
            },
          ],
        },
        "TOOLCHAIN",
        "Absorb toolchain",
        /Java pin to 25/,
      ],
      [{ kind: "approvals" }, "GATE", "Approve runs", /approve its runs/],
      [
        {
          kind: "release-red",
          cls: "BUILD",
          incident: true,
          cause: [{ label: "check", value: "Java Build › Run Java Build" }],
        },
        "BUILD",
        "Investigate",
        /\(Java Build › Run Java Build\)/,
      ],
      [
        {
          kind: "template-red",
          cls: "TEST",
          incident: true,
          cause: [{ label: "reason", value: "failed suites: acceptance" }],
        },
        "TEST",
        "Investigate",
        /^Open the Prove log for the acceptance suite$/,
      ],
      [{ kind: "lanes", cls: "ENV", incident: true }, "ENV", "Re-run lanes", /re-run the lanes/],
      [
        {
          kind: "access",
          cls: "ACCESS",
          incident: true,
          cause: [
            { label: "reason", value: 'denied: "ghcr.io/azure/osdu-spi-legal:pr-9" requires auth' },
          ],
        },
        "ACCESS",
        "Open run, Open PR",
        /^The fork's own image ghcr\.io\/azure\/osdu-spi-legal cannot be pulled \(denied\); the stack is not the cause$/,
      ],
      [{ kind: "stack", rung: 0, cls: "ENV", incident: true }, "ENV", "Re-dispatch", /re-dispatch/],
      [
        { kind: "conflict", rung: 0, cls: "CONFLICT", incident: true },
        "CONFLICT",
        "Investigate, then Dispatch cascade",
        /dispatch the cascade/,
      ],
      [{ kind: "template-set", rung: 2 }, "READY", "Review, then Roll out", /Roll out merges/],
      [{ kind: "releases", rung: 2 }, "READY", "Review on GitHub", /merge it/],
      [{ kind: "bump", rung: 2 }, "READY", "Merge", /^Merge the env bump PR/],
    ];
    for (const [over, cls, verb, next] of rows) {
      const i = item(over);
      expect([itemClass(i), verbOf(i)]).toEqual([cls, verb]);
      expect(nextText(i)).toMatch(next);
    }
  });

  test("a red sync PR takes its failure's verb; a waiting one is a review", () => {
    expect(verbOf(item({ kind: "gate1", cls: "BUILD", incident: true }))).toBe("Investigate");
    expect(verbOf(item({ kind: "gate1" }))).toBe("Review on GitHub");
    expect(verbOf(item({ kind: "gate2" }))).toBe("Merge");
  });

  test("a halt's Next line names the forks that already list the entry", () => {
    const halt = item({
      kind: "halt",
      cls: "HALT",
      halt: { fork: "entitlements", code: "UNKNOWN_TOP_LEVEL", entries: ["schemathesis-tests"] },
    });
    expect(
      nextText(halt, [
        { fork: "storage", verdict: "strip" },
        { fork: "search", verdict: "strip" },
      ]),
    ).toBe(
      "Add a rule for schemathesis-tests to .github/upstream-filter.yml, then dispatch sync · storage and search list it as strip",
    );
  });
});

describe("the banner on the recorded sweep", () => {
  test("the fleet release row names a release on a line already cut and counts first releases", () => {
    const f = fixtureFacts();
    const repos = f.github.data?.repos;
    const spi = repos?.["Azure/osdu-spi"];
    const fork = repos?.["Azure/osdu-spi-partition"];
    if (!repos || !spi || !fork) throw new Error("fixture repos");
    const pr = spi.prs.find((p) => p.number === 248);
    if (!pr) throw new Error("fixture release PR");
    fork.release = undefined;
    fork.prs.push({
      ...pr,
      repo: fork.repo,
      number: 5,
      title: "chore: release 1.4.0",
      url: `${fork.url}/pull/5`,
    });
    const model = buildModel(f, FIXTURE_NOW, {}, fixtureContext);
    const releases = model.queue.items.find((i) => i.kind === "releases");
    expect(releases?.text).toBe(
      "2 release PRs · osdu-spi v1.2.1 and 1 first release · review required",
    );
    if (!releases) throw new Error("releases item");
    expect(releases.scope).toBe("fleet");
    expect([releases.rung, itemClass(releases), verbOf(releases)]).toEqual([
      2,
      "READY",
      "Review on GitHub",
    ]);
  });
});

describe("next steps outside Detail", () => {
  test("keep the internal word cut out of every item's next step, the release row's included", () => {
    const model = buildModel(fixtureFacts(), FIXTURE_NOW, {}, fixtureContext);
    expect(model.queue.items.map((i) => i.kind)).toContain("releases");
    for (const i of model.queue.items) {
      expect(nextText(i, [], fixtureContext.voice), i.id).not.toMatch(/\bcut\b/i);
      expect(readItem(model, i, FIXTURE_NOW, fixtureContext).next, i.id).not.toMatch(/\bcut\b/i);
    }
  });
});
