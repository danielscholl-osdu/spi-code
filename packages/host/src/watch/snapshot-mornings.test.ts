// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { AREAS, buildModel, monthFacts, pinKey, STACK_REPO, TEMPLATE_REPO } from "@spi-code/core";
import { describe, expect, it } from "vitest";
import {
  badInput,
  badSnapshotPath,
  busyInput,
  busySnapshotPath,
  calmInput,
  calmSnapshotPath,
} from "../../test/watch/snapshot-fixture.js";
import { projectWatch } from "./project.js";

process.env.TZ = "UTC";

const itemsOf = (view: ReturnType<typeof projectWatch>) => [
  ...view.briefing.focus,
  ...view.briefing.rest,
];
const stopped = (view: ReturnType<typeof projectWatch>) =>
  view.stations
    .filter((row) => row.stations.some((s) => s.state === "stopped"))
    .map((r) => r.service);

describe("Today morning sweep inputs", () => {
  for (const [name, make, path] of [
    ["calm", calmInput, calmSnapshotPath],
    ["busy", busyInput, busySnapshotPath],
    ["bad", badInput, badSnapshotPath],
  ] as const) {
    it(`${name} deterministically reproduces its saved projection`, () => {
      const view = projectWatch(make());
      expect(projectWatch(make())).toEqual(view);
      expect(view).toEqual(JSON.parse(readFileSync(path, "utf8")));
    });
  }

  it("keeps all 13 calm forks flowing, the latest environment deployable and a quiet horizon", () => {
    const input = calmInput();
    const view = projectWatch(input);
    expect(itemsOf(view).filter((i) => i.attention !== "ambient")).toEqual([]);
    expect(view.areas).toHaveLength(AREAS.length);
    expect(view.areas.every((a) => a.envelope.state === "fresh")).toBe(true);
    expect(
      monthFacts(input.releases, "2026-11", input.context.clock.now(), input.context).unread,
    ).toEqual([]);
    expect(view.releases.lines[0]?.stats.find((s) => s.short === "Releases")?.figure).toMatch(
      /^\d+$/,
    );
    expect(view.stations).toHaveLength(13);
    expect(stopped(view)).toEqual([]);
    expect(view.briefing.facts.find((fact) => fact.label === "Upstream sync")).toEqual({
      label: "Upstream sync",
      figure: "0 of 13",
      sub: "forks stopped · every sync flowing",
      tone: "ok",
    });
    const model = buildModel(input.facts, input.context.clock.now(), {}, input.context);
    expect(model.stack.deployable.state).toBe("yes");
    expect(model.stack.running?.version).toBe(model.stack.latest);
    expect(model.template.rows.filter((r) => r.behind === 0)).toHaveLength(11);
    expect(model.lines.every((l) => !l.syncPr && !l.halt)).toBe(true);
    expect(model.lines.filter((l) => (l.upstream?.lag ?? 0) > 0).map((l) => l.fork.id)).toEqual([
      "partition",
      "schema",
    ]);
  });

  it("populates busy areas, security, releases, decisions, rollout and shared lane evidence", () => {
    const input = busyInput();
    const view = projectWatch(input);
    expect(view.areas.every((a) => a.envelope.state === "fresh")).toBe(true);
    expect(view.areas).toHaveLength(AREAS.length);
    for (const fork of input.context.fleet.forks) {
      const alerts = input.facts.security.data?.[fork.repo];
      expect(alerts?.dependabot?.map((a) => a.severity)).toEqual(["high", "critical"]);
      expect(input.releases.releases[fork.repo]).toHaveLength(1);
      const release = input.releases.releases[fork.repo]?.[0];
      expect(input.releases.pins[pinKey(fork.repo, release?.tag ?? "")]?.lib).toMatch(
        /^\d+\.\d+\.\d+$/,
      );
    }
    const repos = input.facts.github.data?.repos ?? {};
    const releaseRepos = Object.values(repos).filter((r) =>
      r.prs.some((p) => p.head.startsWith("release-please--")),
    );
    expect(releaseRepos).toHaveLength(9);
    expect(releaseRepos.some((r) => r.repo === TEMPLATE_REPO)).toBe(true);
    expect(input.releaseRecords.every((r) => !r.failure)).toBe(true);
    expect(view.provenance.find((p) => p.path === "/releases/lines")?.envelope?.state).toBe(
      "fresh",
    );
    const month = monthFacts(input.releases, "2026-11", input.context.clock.now(), input.context);
    expect(month.unread).toEqual([]);
    expect(view.releases.lines[0]?.stats.find((s) => s.short === "Releases")?.figure).toMatch(
      /^\d+$/,
    );
    expect(month.libs.map(({ version, services }) => [version, services.length])).toEqual([
      ["5.0.0", 2],
      ["4.0.0", 4],
      ["3.0.1", 6],
      ["2.5.10", 1],
    ]);
    const items = itemsOf(view);
    expect(
      items.filter((i) => i.id.startsWith("radar:") && i.attention === "surface"),
    ).toHaveLength(7);
    expect(items.find((i) => i.id === "labels:schema")?.attention).toBe("surface");
    const model = buildModel(input.facts, input.context.clock.now(), {}, input.context);
    const themes = model.lines.flatMap(
      (line) =>
        model.radar.services[line.fork.id]?.certain
          .filter((v) => v.bucket === "Toolchain" || v.bucket === "Halt")
          .map((v) => `${v.bucket}: ${v.value ?? v.entry}`) ?? [],
    );
    expect(themes.sort()).toEqual([
      "Halt: schemathesis-tests",
      "Toolchain: Java 25",
      "Toolchain: Java 25",
      "Toolchain: os-core-common 10.0.0",
      "Toolchain: os-core-common 8.5.0",
      "Toolchain: os-core-common 8.5.0",
      "Toolchain: os-core-common 8.5.0",
    ]);
    expect(model.lines.filter((l) => l.syncPr).map((l) => l.fork.id)).toEqual([
      "indexer",
      "workflow",
      "unit",
      "crs-catalog",
    ]);
    expect(model.template.rows.filter((r) => r.behind === 0)).toHaveLength(7);
    expect(stopped(view)).toEqual(["storage", "indexer-queue"]);
    expect(view.briefing.facts.find((fact) => fact.label === "Upstream sync")).toEqual({
      label: "Upstream sync",
      figure: "2 of 13",
      sub: "forks stopped · storage and indexer-queue",
      tone: "bad",
    });
    const check = repos["Azure/osdu-spi-indexer-queue"]?.prs.find((p) => p.number === 67)
      ?.checks[0];
    expect(check?.url).toBeDefined();
    for (const id of ["stack:lanes", "gate2:indexer-queue"]) {
      expect(items.find((i) => i.id === id)?.evidence.some((e) => e.url === check?.url)).toBe(true);
    }
    expect(
      view.briefing.repositories.rows
        .filter((r) => r.group === "fork")
        .every((r) => r.cells.vulnerabilities.text === "2"),
    ).toBe(true);
    expect(input.releases.releases[STACK_REPO]).toHaveLength(1);
    const forming = view.releases.forming;
    expect(forming?.state).toBe("read");
    expect(forming?.prs).toHaveLength(9);
    expect(forming?.prs.filter((p) => p.kind === "service")).toHaveLength(8);
    expect(forming?.prs.every((p) => p.state === "read" && p.entries.length > 0)).toBe(true);
    const total = forming?.prs.reduce((n, p) => n + p.entries.length, 0);
    expect(Object.values(forming?.kinds ?? {}).reduce((a, b) => a + b, 0)).toBe(total);
    expect(forming?.text).toMatch(/^Unreleased, in 9 open release PRs: /);
    expect(forming?.notable.map((n) => n.kind)).toEqual(["breaking", "security", "new"]);
  });

  it("gives only busy one In progress line and keeps Can wait empty on busy and bad", () => {
    const busy = projectWatch(busyInput());
    expect(busy.briefing.ambient?.inProgress.lines).toHaveLength(1);
    expect(busy.briefing.ambient?.inProgress.lines[0]).toMatchObject({
      itemIds: ["gate1:crs-catalog"],
      service: "crs-catalog",
      station: "sync",
      pr: { number: 54 },
      state: { text: "review" },
    });
    const bad = projectWatch(badInput());
    expect(bad.briefing.ambient?.inProgress.lines).toEqual([]);
    for (const view of [busy, bad]) {
      expect(view.briefing.canWait?.items).toEqual([]);
      expect(view.briefing.canWait?.chips).toEqual([]);
    }
  });

  it("keeps the bad morning's last good GitHub figures with three ordered Interrupts", () => {
    const input = badInput();
    const view = projectWatch(input);
    const interrupts = itemsOf(view).filter((i) => i.attention === "interrupt");
    expect(interrupts.map((i) => i.rung)).toEqual([0, 1, 1]);
    expect(stopped(view)).toEqual(["entitlements", "legal", "storage", "indexer-queue"]);
    expect(view.briefing.facts.find((fact) => fact.label === "Upstream sync")).toEqual({
      label: "Upstream sync",
      figure: "4 of 13",
      sub: "forks stopped · entitlements, legal, storage and indexer-queue",
      tone: "bad",
    });
    expect(view.areas.find((a) => a.area === "github")?.envelope).toMatchObject({
      state: "failed",
      observedAt: "2026-11-06T13:52:00Z",
    });
    expect(
      view.areas.filter((a) => a.area !== "github").every((a) => a.envelope.state === "fresh"),
    ).toBe(true);
    expect(input.facts.github).toMatchObject({ at: "2026-11-06T13:52:00Z", errorAt: view.sweptAt });
    const good = badInput();
    delete good.facts.github.error;
    delete good.facts.github.errorAt;
    const retained = projectWatch(good);
    expect(view.stations).toEqual(retained.stations);
    expect(view.briefing.facts).toEqual(retained.briefing.facts);
    expect(view.releases).toEqual(retained.releases);
  });
});
