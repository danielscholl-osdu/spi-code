// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import snapshot from "../../../fixtures/watch/snapshot-mixed-59d6895.json";
import { releaseDoc } from "../src/brief/release";
import { STACK_REPO, TEMPLATE_REPO } from "../src/config";
import { buildModel } from "../src/model/index";
import { monthFacts, parseBody, releaseMonths } from "../src/model/releases";
import type { NotesRead } from "../src/notes";
import type { ReleaseReads } from "../src/releases";
import { FORKS, fixtureContext } from "./briefing-setup";
import fixture from "./fixtures/rib-59d6895/releases.json";
import { fixtureFacts } from "./harness";
import { skeleton } from "./release-fixtures";

const NOW = new Date("2026-10-21T15:00:00Z");
function reads(): ReleaseReads {
  return structuredClone(fixture) as ReleaseReads;
}

describe("release bodies", () => {
  test("typed by section, with links, PR numbers and automation noise dropped", () => {
    const lines = parseBody(`## [1.3.3](https://x/compare/v1.3.2...v1.3.3) (2026-10-20)
### ⚠ BREAKING CHANGES
* build on Java 25 (#5)
### ✨ Features
* **sizing:** Write spi-sizing from resources ([abc1234](https://x/commit/abc1234))
* Upgrade the gateway to Istio
* Sync upstream changes from a2c4f7b7
### 🐛 Bug Fixes
* **deps:** Bump virtualenv to 21.14.5 to clear advisories (#361)
* **deps:** Bump jackson to 2.21.7
* [Venus] CI-friendly Maven versions
* CVE remediation wave 1 (tomcat, jackson-databind)
### 🔧 Miscellaneous
* Remove Azure provider`);
    expect(lines).toEqual([
      { type: "breaking", text: "build on Java 25", dep: false },
      { type: "new", text: "Write spi-sizing from resources", dep: false, scope: "sizing" },
      { type: "improved", text: "Upgrade the gateway to Istio", dep: false },
      {
        type: "security",
        text: "Bump virtualenv to 21.14.5 to clear advisories",
        dep: true,
        scope: "deps",
      },
      { type: "fixed", text: "Bump jackson to 2.21.7", dep: true, scope: "deps" },
      { type: "fixed", text: "CI-friendly Maven versions", dep: false },
      { type: "security", text: "CVE remediation wave 1 (tomcat, jackson-databind)", dep: false },
    ]);
  });

  test("untyped sections keep their dependency bumps and drop the rest", () => {
    const lines = parseBody(`## [1.2.1](https://x/compare/v1.2.0...v1.2.1) (2026-10-15)
### Miscellaneous Chores
* **deps:** bump spring-boot to 3.5.16
* Remove Azure provider`);
    expect(lines).toEqual([
      { type: "fixed", text: "bump spring-boot to 3.5.16", dep: true, scope: "deps" },
    ]);
  });
});

describe("a calendar month from the recorded release read", () => {
  test("October: versions move from the last release before the month to the last inside it", () => {
    const f = monthFacts(reads(), "2026-10", NOW, fixtureContext);
    expect(f.open).toBe(true);
    expect(f.through).toBe("Oct 1 to 21");
    // The suite runs on the five forks the recorded sweep watched.
    expect(f.releases).toBe(37);
    expect(f.released).toBe(8);
    const by = Object.fromEntries(f.components.map((c) => [c.id, c]));
    expect([by.partition?.from, by.partition?.to, by.partition?.count]).toEqual([
      "v1.3.0",
      "v1.3.3",
      3,
    ]);
    expect(by.entitlements?.from).toBeUndefined();
    expect(by.entitlements?.pins).toEqual({ lib: "3.0.3", java: "25" });
    expect(f.services.forkedNow).toEqual([]);
    expect(monthFacts(reads(), "2026-09", NOW, fixtureContext).services.forkedNow).toEqual([
      "entitlements",
      "legal",
      "schema",
      "file",
    ]);
    expect(f.stack).toBe("v0.30.2");
  });

  test("a fork's first release is one line, not the template history it inherits", () => {
    const f = monthFacts(reads(), "2026-10", NOW, fixtureContext);
    const legal = f.changes.filter((c) => c.component === "legal");
    expect(legal[0]?.text).toBe("legal forked and released as v1.2.0");
    expect(legal.slice(1).map((c) => c.tag)).toEqual(["v1.2.1", "v1.2.1"]);
    expect(f.changes.some((c) => c.component === "core-lib-azure" && c.type === "breaking")).toBe(
      true,
    );
  });

  test("months run newest first and always include the month in progress", () => {
    const months = releaseMonths(reads(), new Date("2026-12-02T00:00:00Z"));
    expect(months[0]).toBe("2026-12");
    expect(months).toContain("2026-09");
  });

  test("a closed month reads its whole window", () => {
    const f = monthFacts(reads(), "2026-09", NOW, fixtureContext);
    expect(f.open).toBe(false);
    expect(f.through).toBe("Sep 1 to 30");
    expect(f.components.find((c) => c.id === "core-lib-azure")).toBeUndefined();
  });

  test("dependency bumps count once per component, and template bumps not at all", () => {
    const body =
      "## 1.0.1\n### Miscellaneous Chores\n* **deps:** bump jackson to 2.21.7\n* **deps:** bump jackson to 2.21.7";
    const r = reads();
    const fork = FORKS[0]?.repo ?? "";
    r.releases[TEMPLATE_REPO] = [{ tag: "v9.0.0", at: "2026-10-20T00:00:00Z", body }];
    r.releases[fork] = [
      { tag: "v9.0.1", at: "2026-10-20T00:00:00Z", body },
      ...(r.releases[fork] ?? []).filter((x) => x.at < "2026-10"),
    ];
    for (const repo of Object.keys(r.releases)) {
      if (repo !== TEMPLATE_REPO && repo !== fork) {
        r.releases[repo] = (r.releases[repo] ?? []).filter((x) => x.at < "2026-10");
      }
    }
    expect(monthFacts(r, "2026-10", NOW, fixtureContext).deps).toBe(1);
  });

  test("a repository never read is unknown, not empty", () => {
    const r = reads();
    delete r.releases[STACK_REPO];
    const f = monthFacts(r, "2026-10", NOW, fixtureContext);
    expect(f.releases).toBeNull();
    expect(f.unread).toContain("spi-stack");
    const doc = releaseDoc(f, undefined, NOW);
    expect(doc.stats[1]?.figure).toBe("?");
    expect(doc.rows.find((x) => x.id === "spi-stack")).toMatchObject({
      version: "?",
      releases: null,
      state: "unread",
    });
  });
});

describe("release history and the current service gate", () => {
  const repo = "Azure/osdu-spi-entitlements";

  test("the mixed fixture keeps the October 12 GitHub station separate from October 21 release history, as the rib does", () => {
    const facts = fixtureFacts();
    const r = reads();
    const row = releaseDoc(monthFacts(r, "2026-10", NOW, fixtureContext), undefined, NOW).rows.find(
      (row) => row.id === "entitlements",
    );
    const station = buildModel(facts, NOW, {}, fixtureContext)
      .lines.find((line) => line.fork.id === "entitlements")
      ?.stations.find((station) => station.id === "release");
    if (!row || !station) throw new Error("fixture has entitlements release row and station");

    expect(row).toMatchObject({
      version: "new → v1.2.1",
      to: r.releases[repo]?.[0]?.tag,
      releases: 2,
      state: "released",
    });
    expect(station).toEqual({ id: "release", state: "idle", text: "v1.2.0" });
    expect(station.text).toBe(facts.github.data?.repos[repo]?.release?.tag);
    expect(
      snapshot.stations
        .find((line) => line.service === "entitlements")
        ?.stations.find((station) => station.id === "release"),
    ).toMatchObject(station);
    expect(
      snapshot.services
        .find((service) => service.service === "entitlements")
        ?.releases.find((row) => row.month === "2026-10"),
    ).toMatchObject({
      ...row,
      month: "2026-10",
      gate: { state: station.state, text: station.text },
    });
  });

  test("refreshing GitHub's latest release advances the station without changing release history", () => {
    const facts = fixtureFacts();
    const r = reads();
    const github = facts.github.data?.repos[repo];
    const latest = r.releases[repo]?.[0];
    if (!github?.release || !latest) throw new Error("fixture has entitlements releases");
    const before = releaseDoc(monthFacts(r, "2026-10", NOW, fixtureContext), undefined, NOW);
    github.release = { ...github.release, tag: latest.tag, at: latest.at };
    const station = buildModel(facts, NOW, {}, fixtureContext)
      .lines.find((line) => line.fork.id === "entitlements")
      ?.stations.find((station) => station.id === "release");

    expect(station).toEqual({ id: "release", state: "idle", text: "v1.2.1" });
    expect(releaseDoc(monthFacts(r, "2026-10", NOW, fixtureContext), undefined, NOW)).toEqual(
      before,
    );
  });
});

describe("the document", () => {
  test("without notes it is a draft from computed facts, breaking changes ask for review", () => {
    const doc = releaseDoc(monthFacts(reads(), "2026-10", NOW, fixtureContext), undefined, NOW);
    expect(doc.notes).toBe("none");
    expect(doc.headline).toBe("37 releases across 8 repositories in October 2026.");
    expect(doc.required.every((a) => a.level === "recommended")).toBe(true);
    expect(doc.required.length).toBeGreaterThan(0);
    const engineering = doc.changelog.find((a) => a.area === "Engineering system");
    expect(engineering?.items).toHaveLength(1);
    expect(engineering?.items[0]?.text).toContain("to fork automation");
  });

  test("a notes file's actions replace the computed ones, even when it lists none", () => {
    const f = monthFacts(reads(), "2026-10", NOW, fixtureContext);
    expect(releaseDoc(f, undefined, NOW).required.length).toBeGreaterThan(0);
    const read: NotesRead = {
      state: "ok",
      path: "/x/2026-10.json",
      notes: { ...skeleton(), status: "approved", headline: "Reviewed" },
    };
    expect(releaseDoc(f, read, NOW).required).toEqual([]);
    const untouched = releaseDoc(
      f,
      { state: "ok", path: "/x/2026-10.json", notes: skeleton() },
      NOW,
    );
    expect(untouched.required.length).toBeGreaterThan(0);
    expect(untouched.stats.slice(2).map((x) => x.figure)).toEqual(["?", "?"]);
  });
});
