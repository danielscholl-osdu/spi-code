// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, test } from "vitest";
import {
  fleetView,
  parseForks,
  readFleet,
  resolveFleet,
  resolveRollout,
  upstreamProject,
} from "../../src/collect/fleet.js";
import { fleetOf, GITLAB_EVERY_MS, KNOWN_SERVICES } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { envelopeOf } from "../../src/evidence/index.js";
import type { Exec } from "../../src/exec/index.js";
import { Gh } from "../../src/forge.js";
import { buildModel } from "../../src/model/index.js";
import { FIXTURE_NOW, fixtureFacts } from "../harness.js";

const now = FIXTURE_NOW;
const later = new Date(now.getTime() + GITLAB_EVERY_MS);
const extra = { service: "wellbore", repo: "Azure/osdu-spi-wellbore", upstream: "osdu/wellbore" };
const url = `https://community.opengroup.org/${extra.upstream}.git`;
const rollout = JSON.stringify({
  schema: 1,
  lanes: 5,
  ordering: [{ service: "search", after: ["storage", "indexer"], reason: "reads records" }],
  ignored: true,
});
const yaml = (ids = KNOWN_SERVICES.map((s) => s.id)) =>
  `forks:\n${ids.map((id) => `  - service: ${id}\n    repo: Azure/osdu-spi-${id}`).join("\n")}`;

function fleetGh(
  stack: string | null = yaml(),
  policy: string | null = null,
  vars: Record<string, { name: string; value: string }[] | Error> = {},
  failure?: string,
  errors: { message: string }[] = [],
) {
  const calls: string[] = [];
  const exec: Exec = {
    runText: async (_cmd, args) => {
      calls.push(args.join(" "));
      if (failure) return { ok: false, error: failure, code: 1 };
      return {
        ok: true,
        data: JSON.stringify({
          data: {
            stack: { object: stack === null ? null : { text: stack } },
            template: { object: policy === null ? null : { text: policy } },
          },
          errors,
        }),
        exitCode: 0,
      };
    },
    runJSON: async <T>(_cmd: string, args: string[]) => {
      calls.push(args.join(" "));
      const repo = /repos\/([^/]+\/[^/]+)\/actions\/variables/.exec(args[1] ?? "")?.[1] ?? "";
      const value = vars[repo] ?? [];
      return value instanceof Error
        ? { ok: false, error: value.message, code: 1 }
        : { ok: true, data: value as T };
    },
  };
  return { gh: new Gh(exec), calls };
}
const extended = () => yaml([...KNOWN_SERVICES.map((s) => s.id), extra.service]);
const upstream = { [extra.repo]: [{ name: "UPSTREAM_REPO_URL", value: url }] };

test("14 forks: the 13 known by identity, the new one by its UPSTREAM_REPO_URL; independent contexts", async () => {
  const data = await readFleet(fleetGh(extended(), null, upstream).gh, undefined, now);
  expect(data.forks).toHaveLength(14);
  const fleet = resolveFleet(data);
  expect(fleet.unresolved).toEqual([]);
  expect(fleet.services.find((s) => s.id === extra.service)).toMatchObject({
    repo: extra.repo,
    upstream: extra.upstream,
    mirror: false,
  });
  expect(fleet.services.find((s) => s.id === "entitlements")?.prefix).toBe("entitlements-v2");
  const other = await readFleet(fleetGh(yaml(["legal"])).gh, undefined, now);
  const first = createContext({ fleet: fleetOf(fleet.services) });
  const second = createContext({ fleet: fleetOf(resolveFleet(other).services) });
  expect(buildModel(fixtureFacts(), now, {}, first).lines.map((l) => l.fork.id)).toContain(
    extra.service,
  );
  expect(second.fleet.forks.map((f) => f.id)).toEqual(["legal"]);
  expect(first.fleet.forks).toHaveLength(14);
});

test("a fork with no upstream it can find is not followed", async () => {
  const data = await readFleet(fleetGh(extended()).gh, undefined, now);
  expect(resolveFleet(data).services).toHaveLength(13);
  expect(resolveFleet(data).unresolved).toEqual([
    { service: extra.service, why: "it has no UPSTREAM_REPO_URL variable" },
  ]);
});

test("variables are read again only on GitLab's cadence or for a new fork", async () => {
  const first = fleetGh();
  const data = await readFleet(first.gh, undefined, now);
  expect(first.calls.filter((c) => c.includes("/actions/variables"))).toHaveLength(13);
  for (const [time, text, count] of [
    [new Date(now.getTime() + 300_000), yaml(), 0],
    [later, yaml(), 13],
    [new Date(now.getTime() + 300_000), extended(), 14],
  ] as const) {
    const next = fleetGh(text);
    const result = await readFleet(next.gh, data, time);
    expect(next.calls.filter((c) => c.includes("/actions/variables"))).toHaveLength(count);
    expect(result.reads.filter((r) => r.object === "actions/variables")).toHaveLength(count || 13);
  }
});

test("a failed read keeps the last good list and its original observation across retries", async () => {
  const good = await readFleet(fleetGh(extended(), rollout, upstream).gh, undefined, now);
  const failed = await readFleet(fleetGh(undefined, null, {}, "network down").gh, good, later);
  const retried = await readFleet(fleetGh(null).gh, failed, new Date(later.getTime() + 1));
  expect(retried.forks).toEqual(good.forks);
  expect(failed.rollout).toBe(rollout);
  expect(retried.reads.find((r) => r.object.endsWith(".yaml"))).toMatchObject({
    failure: expect.any(String),
    retainedFrom: now.toISOString(),
  });
  expect(envelopeOf(failed.reads, { now: later.getTime(), intervalMs: 300_000 }).state).toBe(
    "failed",
  );
  const cold = await readFleet(fleetGh(null).gh, undefined, now);
  expect(cold.reads[0]?.retainedFrom).toBeUndefined();
  expect(cold.reads[0]?.failure).toContain("has no");
});

test("the upstream project comes from the GitLab URL, with or without .git", () => {
  expect(upstreamProject(url)).toBe(extra.upstream);
  expect(upstreamProject(url.replace(".git", ""))).toBe(extra.upstream);
  for (const value of [
    undefined,
    "invalid",
    "https://gitlab.com/osdu/x",
    "https://communityXopengroup.org/osdu/x",
    "https://community.opengroup.org.evil.io/osdu/x",
    "ftp://community.opengroup.org/x",
  ]) {
    expect(upstreamProject(value)).toBeUndefined();
  }
});

test("missing rollout leaves the fleet buttons unpaced", async () => {
  const data = await readFleet(fleetGh().gh, undefined, now);
  expect(data.rollout).toBeNull();
  expect(resolveRollout(data)).toEqual({ warnings: [] });
  expect(fleetView(data, {}, { now })).toMatchObject({ rolloutMissing: true });
});

test("lanes and ordering are read; unknown fields are ignored", async () => {
  const data = await readFleet(fleetGh(yaml(), rollout).gh, undefined, now);
  expect(data.rolloutFrom).toBe("Azure/osdu-spi:.github/fleet/rollout.json");
  const view = fleetView(data, {}, { now });
  expect(view.rollout.rollout).toEqual({
    lanes: 5,
    ordering: [{ service: "search", after: ["storage", "indexer"], reason: "reads records" }],
  });
  const context = createContext({
    fleet: fleetOf(view.fleet.services),
    rollout: view.rollout.rollout,
  });
  expect(buildModel(fixtureFacts(), now, {}, context).lanes.cap).toBe(5);
  expect(
    data.reads.filter((r) => r.object.endsWith(".yaml") || r.object.endsWith(".json")),
  ).toHaveLength(2);
});

test("an override path that does not exist reads as missing, without a GitHub call", async () => {
  const { gh, calls } = fleetGh();
  const files = { services: "/pinned/services.json", rollout: "/nowhere/rollout.json" };
  const data = await readFleet(gh, undefined, now, files);
  expect(calls).toEqual([]);
  expect(data.forks).toBeUndefined();
  expect(data.rollout).toBeUndefined();
  const view = fleetView(data, files, { now, readFile: () => null });
  expect(view).toMatchObject({
    rolloutMissing: true,
    rolloutFrom: files.rollout,
    rollout: { warnings: [] },
  });
  expect(view.reads.find((r) => r.object === files.services)?.failure).toContain("not readable");
});

test("a failed variables read keeps the last good values; never read fails closed", async () => {
  const values = { ...upstream, "Azure/osdu-spi-file": [{ name: "SYNC_MODE", value: "mirror" }] };
  const good = await readFleet(fleetGh(extended(), null, values).gh, undefined, now);
  const down = Object.fromEntries((good.forks ?? []).map((f) => [f.repo, new Error("HTTP 502")]));
  const again = await readFleet(fleetGh(extended(), null, down).gh, good, later);
  expect(resolveFleet(again).services.find((s) => s.id === extra.service)?.upstream).toBe(
    extra.upstream,
  );
  expect(resolveFleet(again).services.find((s) => s.id === "file")?.mirror).toBe(true);
  expect(again.reads.find((r) => r.source === extra.repo)).toMatchObject({
    failure: expect.stringContaining("502"),
    retainedFrom: now.toISOString(),
  });
  const never = await readFleet(fleetGh(yaml(), null, down).gh, undefined, now);
  expect(resolveFleet(never).services.every((s) => s.mirror === null)).toBe(true);
});

test("a services file wins over a stack list read before it was set", async () => {
  const data = await readFleet(fleetGh(extended()).gh, undefined, now);
  const services = [{ id: "pinned", repo: "owner/pinned", upstream: "osdu/pinned" }];
  const view = fleetView(
    data,
    { services: "/services" },
    { now, readFile: () => JSON.stringify(services) },
  );
  expect(view.fleet).toEqual({ source: "file", services, unresolved: [] });
});

test("a fleet read GitHub answers with errors fails, so the last good rollout stays", async () => {
  const good = await readFleet(fleetGh(yaml(), rollout).gh, undefined, now);
  const next = await readFleet(
    fleetGh(yaml(), null, {}, undefined, [{ message: "Something went wrong" }]).gh,
    good,
    later,
  );
  expect(next.rollout).toBe(rollout);
  expect(
    next.reads
      .filter((r) => r.object !== "actions/variables")
      .every((r) => r.failure?.includes("Something went wrong")),
  ).toBe(true);
});

test("a local rollout file sets the cap even when the remote fleet read fails", async () => {
  const good = await readFleet(fleetGh(yaml(), rollout).gh, undefined, now);
  const failed = await readFleet(fleetGh(undefined, null, {}, "network down").gh, good, later, {
    rollout: "/rollout",
  });
  for (const lanes of [1, 2]) {
    const view = fleetView(
      failed,
      { rollout: "/rollout" },
      { now: later, readFile: () => JSON.stringify({ schema: 1, lanes }) },
    );
    expect(view.rollout.rollout?.lanes).toBe(lanes);
    expect(view.reads.find((r) => r.source === "file")?.failure).toBeUndefined();
  }
});

test("failed local fork-file reads retain the previous fleet with retainedFrom", () => {
  const files = { services: "/services" };
  const good = fleetView(undefined, files, {
    now,
    readFile: () => JSON.stringify([KNOWN_SERVICES[0]]),
  });
  const failed = fleetView(undefined, files, {
    now: later,
    previous: good,
    readFile: () => {
      throw new Error("EACCES");
    },
  });
  const again = fleetView(undefined, files, { now: later, previous: failed, readFile: () => "{" });
  expect(again.fleet).toEqual(good.fleet);
  expect(failed.reads[0]).toMatchObject({ failure: "EACCES", retainedFrom: now.toISOString() });
  expect(again.reads[0]?.retainedFrom).toBe(now.toISOString());
});

test("fork YAML skips invalid entries, deduplicates identity on resolution and rejects empty lists", () => {
  const entries = parseForks(
    "forks:\n - service: legal\n   repo: owner/legal\n   canonicalSource: fork\n - service: legal\n   repo: owner/duplicate\n - repo: invalid\n - service: invalid\n   repo: bad/repo/path\n",
  );
  expect(entries[0]?.canonicalSource).toBe("fork");
  expect(resolveFleet({ forks: entries, vars: {} }).services).toHaveLength(1);
  for (const text of ["{", "", "forks: {}", "forks: []"]) expect(() => parseForks(text)).toThrow();
});
