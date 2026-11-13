// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { PlaceId, PlaceVisual } from "@spi-code/contracts";
import { buildModel, stationSubstateOf } from "@spi-code/core";
import { describe, expect, it } from "vitest";
import { horizonWaitServices } from "../../../core/src/brief/horizon.js";
import { placesOf } from "../../../core/src/brief/places.js";
import {
  badInput,
  busyInput,
  calmInput,
  fixtureInput,
  mixedFixtureInput,
  recordedInput,
  unreadForksInput,
  unverifiedForkInput,
} from "../../test/watch/snapshot-fixture.js";
import { projectWatch, type WatchInput } from "./project.js";

function visual<K extends PlaceVisual["kind"]>(input: WatchInput, place: PlaceId, kind: K) {
  const value = projectWatch(input).briefing.places?.find((row) => row.place === place)?.visual;
  expect(value?.kind).toBe(kind);
  if (value?.kind !== kind) throw new Error(`Missing ${place} visual`);
  return value as Extract<PlaceVisual, { kind: K }>;
}
const modelOf = (input: WatchInput) =>
  buildModel(input.facts, input.context.clock.now(), {}, input.context);

describe("Today place micro-visuals (PS-03, PS-09)", () => {
  it("snapshot-busy: keeps fork order and each fork's worst Line station", () => {
    const input = busyInput();
    const model = modelOf(input);
    const pips = visual(input, "line", "pips");
    expect(pips.slots.map((slot) => slot.service)).toEqual(model.lines.map((line) => line.fork.id));
    const rank = ["broken", "waiting", "unknown", "occupied", "empty"];
    const states = {
      stopped: "broken",
      "waiting-on-person": "waiting",
      "waiting-on-clock": "occupied",
      "in-progress": "occupied",
      ready: "empty",
    } as const;
    for (const [index, line] of model.lines.entries()) {
      const worst = line.stations
        .map((station) =>
          station.state === "unknown"
            ? "unknown"
            : states[stationSubstateOf(station, line, input.facts)],
        )
        .sort((a, b) => rank.indexOf(a) - rank.indexOf(b))[0];
      expect(pips.slots[index]?.state).toBe(worst);
      expect(pips.slots[index]?.text).toContain(line.fork.id);
    }
    const stopped = pips.slots
      .filter((slot) => slot.state === "broken")
      .map((slot) => slot.service);
    expect(pips.stopped).toEqual(stopped);
    expect(projectWatch(input).briefing.places?.[0]?.figure).toContain(`${stopped.length} of 13`);
  });

  it("keeps a read stopped station visible when the fork repository is unread", () => {
    const input = busyInput();
    const fork = input.context.fleet.forks.find((fork) => fork.id === "storage");
    if (!fork || !input.facts.github.data) throw new Error("No storage fixture");
    delete input.facts.github.data.repos[fork.repo];
    const pips = visual(input, "line", "pips");
    expect(pips.slots.find((slot) => slot.service === "storage")).toMatchObject({
      state: "broken",
    });
    expect(pips.stopped).toEqual(["storage", "indexer-queue"]);
    expect(projectWatch(input).briefing.places?.[0]?.figure).toContain("At least 2 of 13 stopped");
  });

  it("ranks a stopped station ahead of a station waiting for a person", () => {
    const input = busyInput();
    const snapshot = projectWatch(input);
    const model = modelOf(input);
    const line = model.lines[0];
    if (!line) throw new Error("No Line fixture");
    delete input.facts.runs.data?.[line.fork.repo];
    line.cascadeStop = false;
    line.stations = [
      { id: "upstream", state: "stopped", text: "Upstream stopped" },
      { id: "cascade", state: "waiting", text: "Waiting for approval" },
    ];
    expect(line.stations.map((station) => stationSubstateOf(station, line, input.facts))).toEqual([
      "stopped",
      "waiting-on-person",
    ]);
    const pips = placesOf({
      readings: snapshot.readings,
      areas: snapshot.areas,
      source: { model, facts: input.facts, reads: input.reads },
      items: [],
    })[0]?.visual;
    expect(pips?.kind === "pips" && pips.slots[0]?.state).toBe("broken");
  });

  it("matches the need-you horizon cards' item forks on every morning, including Interrupt halts", () => {
    for (const input of [
      calmInput(),
      busyInput(),
      badInput(),
      recordedInput(),
      unreadForksInput(),
      unverifiedForkInput(),
      fixtureInput(),
      mixedFixtureInput(),
    ]) {
      const snapshot = projectWatch(input);
      const model = modelOf(input);
      const ids = new Set(
        snapshot.briefing.horizon.cards
          ?.filter((card) => card.needsYou)
          .flatMap((card) => card.itemIds),
      );
      const forks = new Set(
        model.queue.items.filter((item) => ids.has(item.id)).map((item) => item.scope),
      );
      expect(
        horizonWaitServices(
          model,
          input.facts,
          [...snapshot.briefing.focus, ...snapshot.briefing.rest],
          snapshot.briefing.horizon.cards,
        ),
      ).toEqual(forks);
      const pips = visual(input, "line", "pips");
      expect(pips.horizon?.count ?? 0).toBe(forks.size);
      expect(
        pips.slots
          .filter((slot) => forks.has(slot.service))
          .map((slot) => slot.service)
          .sort(),
      ).toEqual([...forks].sort());
    }
  });

  it("counts upstream person waits from the horizon's own item membership, once per fork", () => {
    const input = busyInput();
    const snapshot = projectWatch(input);
    const model = modelOf(input);
    const items = [...snapshot.briefing.focus, ...snapshot.briefing.rest];
    const services = new Set(
      model.queue.items
        .filter((q) =>
          items.some(
            (item) =>
              item.attention === "surface" &&
              item.origin === "upstream" &&
              (item.id === q.id || item.ids.includes(q.id)),
          ),
        )
        .map((q) => q.scope),
    );
    expect(services.size).toBeGreaterThan(0);
    const cardIds = new Set(snapshot.briefing.horizon.cards?.flatMap((card) => card.itemIds));
    const cardForks = new Set(
      model.queue.items
        .filter(
          (q) =>
            cardIds.has(q.id) &&
            items.some((item) => item.id === q.id && item.attention === "surface"),
        )
        .map((q) => q.scope),
    );
    expect(cardForks).toEqual(services);
    const withoutJoin = placesOf({
      readings: snapshot.readings,
      areas: snapshot.areas,
      source: { model, facts: input.facts, reads: input.reads, cards: [] },
      items,
    })[0]?.visual;
    expect(withoutJoin?.kind === "pips" && withoutJoin.horizon).toBeUndefined();
    const pips = visual(input, "line", "pips");
    expect(pips.horizon).toEqual({
      count: services.size,
      text: `⇣ ${services.size} on the horizon`,
    });
    const upstreamServices = new Set([
      ...services,
      ...(snapshot.briefing.ambient?.inProgress.lines
        .filter((line) => line.origin === "upstream")
        .flatMap((line) => (line.service ? [line.service] : [])) ?? []),
    ]);
    expect(upstreamServices.has("crs-catalog")).toBe(true);
    for (const slot of pips.slots.filter((slot) => slot.origin === "upstream")) {
      expect(upstreamServices.has(slot.service)).toBe(true);
    }
    for (const slot of pips.slots.filter((slot) => slot.state === "waiting")) {
      expect(slot.origin).toBe(upstreamServices.has(slot.service) ? "upstream" : "system");
    }
  });

  it("keeps an upstream sync PR's person-wait upstream after its tier becomes Ambient", () => {
    const input = busyInput();
    const snapshot = projectWatch(input);
    const rows = placesOf({
      readings: snapshot.readings,
      areas: snapshot.areas,
      source: { model: modelOf(input), facts: input.facts, reads: input.reads },
      items: [...snapshot.briefing.focus, ...snapshot.briefing.rest].map((item) => ({
        ...item,
        attention: "ambient" as const,
      })),
    });
    const pips = rows[0]?.visual;
    if (pips?.kind !== "pips") throw new Error("Missing Line visual");
    expect(pips.slots.find((slot) => slot.service === "indexer")).toMatchObject({
      state: "waiting",
      origin: "upstream",
    });
    expect(pips.horizon?.count).toBe(4);
  });

  it("keeps an in-system person-wait in system colour even with an upstream decision on that fork", () => {
    const input = busyInput();
    const snapshot = projectWatch(input);
    const model = modelOf(input);
    const line = model.lines.find((line) => line.fork.id === "entitlements");
    const radar = model.queue.items.find((item) => item.kind === "radar");
    if (!line || !radar) throw new Error("No station fixture");
    line.stations = [{ id: "cascade", state: "waiting", text: "Waiting for approval" }];
    model.queue.items.push({ ...radar, id: "radar:entitlements", scope: "entitlements" });
    const rows = placesOf({
      readings: snapshot.readings,
      areas: snapshot.areas,
      source: { model, facts: input.facts, reads: input.reads },
      items: [{ id: "radar:entitlements", ids: ["radar:entitlements"], attention: "surface" }],
    });
    const pips = rows[0]?.visual;
    if (pips?.kind !== "pips") throw new Error("Missing Line visual");
    expect(pips.slots.find((slot) => slot.service === "entitlements")).toMatchObject({
      state: "waiting",
      origin: "system",
    });
  });

  it("snapshot-busy: Security columns sum to the reading and name only severe shipped rules", () => {
    const input = busyInput();
    const columns = visual(input, "security", "forkColumns");
    const snapshot = projectWatch(input);
    const high = snapshot.readings.find((reading) => reading.anchor.kind === "security")?.content
      ?.tiles[0].value;
    expect(columns.program).toEqual({ count: 0, rules: [], text: "program: 0 high or critical" });
    expect(
      columns.columns.reduce((sum, column) => sum + (column.count ?? 0), 0) +
        (columns.program?.count ?? 0),
    ).toBe(Number(high));
    expect(columns.columns.map((column) => column.service)).toEqual(
      input.context.fleet.forks.map((fork) => fork.id),
    );
    expect(columns.columns.every((column) => column.rules.includes("fixture-library"))).toBe(true);
    expect(columns.largest).toEqual({
      label: "fixture-library",
      forks: 13,
      text: "fixture-library · 13 forks",
    });
  });

  it("reconciles 59d6895's severe findings as 11 in forks plus 3 in program repositories", () => {
    const input = fixtureInput();
    const columns = visual(input, "security", "forkColumns");
    expect(columns.columns.map((column) => column.count)).toEqual([2, 2, 2, 3, 2]);
    expect(columns.program).toMatchObject({ count: 3 });
    expect(columns.program?.rules.length).toBeGreaterThan(0);
    expect(columns.program?.text).toContain("program: 3 high or critical");
    const high = projectWatch(input).readings.find((reading) => reading.anchor.kind === "security")
      ?.content?.tiles[0].value;
    expect(columns.columns.reduce((sum, column) => sum + (column.count ?? 0), 0)).toBe(11);
    expect(11 + (columns.program?.count ?? 0)).toBe(Number(high));
  });

  it("marks the program aggregate unknown if either alert list of any program repository is unread", () => {
    const repos = modelOf(fixtureInput()).repositories.rows.filter(
      (row) => row.group === "program",
    );
    expect(repos.length).toBeGreaterThan(1);
    for (const { repo } of repos) {
      for (const list of ["dependabot", "code"] as const) {
        const input = fixtureInput();
        const alerts = input.facts.security.data?.[repo];
        if (!alerts) throw new Error("No program security fixture");
        delete alerts[list];
        expect(visual(input, "security", "forkColumns").program).toMatchObject({
          count: null,
          text: "program: Security not fully read yet",
        });
      }
    }
  });

  it("snapshot-1106: unread Security columns are unknown instead of zero", () => {
    const columns = visual(recordedInput(), "security", "forkColumns");
    expect(columns.columns).toHaveLength(13);
    expect(
      columns.columns.every((column) => column.count === null && /not.*read/.test(column.text)),
    ).toBe(true);
    expect(columns.largest).toBeUndefined();
    expect(columns.program).toMatchObject({ count: null });
  });

  it("marks a partially unread fork's Security column unknown", () => {
    const input = busyInput();
    const fork = input.context.fleet.forks[0];
    if (!fork || !input.facts.security.data) throw new Error("No security fixture");
    delete input.facts.security.data[fork.repo]?.code;
    expect(visual(input, "security", "forkColumns").columns[0]).toMatchObject({ count: null });
  });

  it("matches all four 21-day lifecycle values and green-since to the stack model", () => {
    const input = busyInput();
    const stack = modelOf(input).stack;
    const lifecycle = visual(input, "environment", "lifecycle");
    expect(lifecycle.lanes.map((lane) => lane.lane)).toEqual([
      "refresh",
      "upgrade",
      "smoke",
      "sweeper",
    ]);
    for (const lane of lifecycle.lanes) {
      expect(lane.green).toBe(stack.lifecycle[lane.lane].green);
      expect(lane.total).toBe(stack.lifecycle[lane.lane].total);
      expect(lane.text).toContain("21 days");
    }
    expect(lifecycle.greenSince).toBe(
      stack.deployable.state === "yes" ? stack.maintenance.since : undefined,
    );
  });

  it("marks missing or expired lifecycle history unknown, never 0 of 0", () => {
    for (const source of [undefined, { refresh: [], upgrade: [], smoke: [], sweeper: [] }]) {
      const input = busyInput();
      input.facts.lifecycle = source ? { data: source } : {};
      const lifecycle = visual(input, "environment", "lifecycle");
      expect(
        lifecycle.lanes.every((lane) => lane.state === "unknown" && /not read/.test(lane.text)),
      ).toBe(true);
      expect(lifecycle.lanes.some((lane) => lane.text.includes("0 of 0"))).toBe(false);
      expect(lifecycle.greenSince).toBeUndefined();
    }
  });

  it("excludes old lifecycle history from the pass rate and marks it unknown", () => {
    const input = busyInput();
    if (!input.facts.lifecycle.data) throw new Error("No lifecycle fixture");
    for (const runs of Object.values(input.facts.lifecycle.data))
      for (const run of runs) run.createdAt = "2025-01-01T00:00:00Z";
    const lifecycle = visual(input, "environment", "lifecycle");
    expect(lifecycle.lanes.every((lane) => lane.state === "unknown" && lane.total === 0)).toBe(
      true,
    );
    expect(lifecycle.greenSince).toBeUndefined();
  });

  it("excludes upstream, test and low-severity findings from Security rules and counts", () => {
    const input = busyInput();
    const fork = input.context.fleet.forks[0];
    const alerts = fork && input.facts.security.data?.[fork.repo];
    const sample = alerts?.dependabot?.[0];
    if (!alerts?.dependabot || !sample) throw new Error("No security fixture");
    alerts.dependabot.push(
      { ...sample, number: 90, package: "upstream-only", manifest: "pom.xml" },
      {
        ...sample,
        number: 91,
        package: "test-only",
        manifest: "testing/example-test-azure/pom.xml",
      },
      { ...sample, number: 92, package: "low-only", severity: "low" },
    );
    const column = visual(input, "security", "forkColumns").columns[0];
    expect(column).toMatchObject({ count: 2, rules: ["fixture-library"] });
  });

  it("keeps unread Line pips unknown", () => {
    const input = unreadForksInput();
    const model = modelOf(input);
    const pips = visual(input, "line", "pips");
    for (const line of model.lines.filter((line) => !line.repoRead))
      expect(pips.slots.find((slot) => slot.service === line.fork.id)?.state).toBe("unknown");
  });

  it("uses verified adoption for done rollout slots and leaves unread forks unknown", () => {
    for (const input of [busyInput(), unreadForksInput()]) {
      const model = modelOf(input);
      const rollout = visual(input, "engineering", "rollout");
      expect(rollout.slots.map((slot) => slot.service)).toEqual(
        model.lines.map((line) => line.fork.id),
      );
      expect(rollout.slots.filter((slot) => slot.state === "done")).toHaveLength(
        model.template.verified,
      );
      expect(rollout.target).toBe(model.rollout?.target.sha ?? model.template.head?.sha);
      for (const row of model.template.rows.filter((row) => row.behind === undefined))
        expect(rollout.slots.find((slot) => slot.service === row.service)?.state).toBe("unknown");
    }
  });

  it("never turns release review alone into a person-wait", () => {
    const input = calmInput();
    const fork = input.context.fleet.forks[0];
    const repo = fork && input.facts.github.data?.repos[fork.repo];
    const release =
      fork &&
      busyInput().facts.github.data?.repos[fork.repo]?.prs.find((pr) =>
        pr.head.startsWith("release-please--"),
      );
    if (!repo || !release) throw new Error("No release fixture");
    repo.prs.push({ ...release, reviewDecision: "REVIEW_REQUIRED" });
    const pips = visual(input, "line", "pips");
    const model = modelOf(input);
    const releaseOnly = model.lines.filter(
      (line) =>
        line.releasePr &&
        line.stations.every(
          (station) => stationSubstateOf(station, line, input.facts) !== "waiting-on-person",
        ),
    );
    expect(releaseOnly.length).toBeGreaterThan(0);
    for (const line of releaseOnly)
      expect(pips.slots.find((slot) => slot.service === line.fork.id)?.state).not.toBe("waiting");
  });
});
