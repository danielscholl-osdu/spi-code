// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SweepProgress } from "@spi-code/contracts";
import { createContext, type Exec, type Facts, fleetOf, RELEASES_EVERY_MS } from "@spi-code/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { openRunStore } from "../store/store.js";
import { SweepService } from "./service.js";

/** The window's Evidence and Settings → Sweep tests render this slice of the second sweep. */
const FIXTURE = "apps/window/src/components/evidence/fixtures/release-reread.json";
const epoch = Date.parse("2026-11-09T23:17:00Z");
const RELEASE = { tag: "v1.0.0", at: "2026-10-01T00:00:00Z", body: "" };
let directory: string;
let db: DatabaseSync;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(epoch);
  directory = mkdtempSync(join(tmpdir(), "spi-release-"));
  const path = join(directory, "store.sqlite");
  openRunStore(path).close();
  db = new DatabaseSync(path);
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});

const offline = { ok: false as const, code: 1, error: "offline fixture" };

/** GitHub answers the release reads; every other source fails offline. */
const exec: Exec = {
  runJSON: async <T>(_cmd: string, args: string[]) =>
    args.some((arg) => arg.includes("/git/trees/"))
      ? { ok: true as const, data: { paths: ["pom.xml"], truncated: false } as T }
      : offline,
  runText: async (_cmd, args) => {
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (path.endsWith("/releases?per_page=100")) return { ok: true, data: JSON.stringify(RELEASE) };
    if (path.endsWith("/git/matching-refs/tags/")) {
      return { ok: true, data: JSON.stringify({ tag: RELEASE.tag, sha: "a".repeat(40) }) };
    }
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    if (!query) return offline;
    const budget = {
      cost: 1,
      remaining: 4000,
      resetAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const data = query.includes("createdAt")
      ? Object.fromEntries([0, 1, 2, 3].map((i) => [`r${i}`, { createdAt: RELEASE.at }]))
      : { repository: { p0: { text: "<java.version>25</java.version>" } } };
    return { ok: true, data: JSON.stringify({ data: { ...data, spicodeBudget: budget } }) };
  },
};

function open(progress: SweepProgress[]) {
  return new SweepService({
    db,
    fleet: "test",
    ctx: createContext({
      fleet: fleetOf([{ id: "service", repo: "test/service", upstream: "upstream/service" }]),
      clock: { now: () => new Date(Date.now()) },
    }),
    exec,
    factsSchema: z.custom<Facts>(),
    appData: directory,
    doctor: () => ({ state: "clear", problems: [] }),
    ttlMs: 3000,
    onError: (error) => {
      throw error;
    },
    onProgress: (event) => progress.push(event),
  });
}

it("stamps Release lines with the read a later sweep makes, cached pins included", async () => {
  const first = open([]);
  await first.start();
  await first.stop();
  const later = epoch + 14 * RELEASES_EVERY_MS;
  vi.setSystemTime(later);
  const progress: SweepProgress[] = [];
  const second = open(progress);
  await second.start();
  const view = second.latest();
  await second.stop();
  if (!view) throw new Error("The second sweep saved no snapshot");

  const at = new Date(later).toISOString();
  const releases = view.provenance.filter(
    ({ path }) => path.startsWith("/releases/lines") || path === "/releases/forming",
  );
  expect(releases.find(({ path }) => path === "/releases/lines")?.envelope).toMatchObject({
    state: "fresh",
    observedAt: at,
  });
  const reads = view.reads.filter(({ source }) => source.startsWith("github-"));
  expect(reads.filter(({ source }) => source === "github-pins")).toHaveLength(1);
  expect(reads.every(({ observedAt }) => observedAt === at)).toBe(true);

  const completed = progress.at(-1);
  if (!completed) throw new Error("The second sweep reported no progress");
  const slice = {
    recordedFrom: "packages/host/src/sweep/release-freshness.test.ts",
    now: at,
    snapshot: { sweptAt: view.sweptAt, provenance: releases, reads },
    progress: {
      ...completed,
      sweep: "release-reread",
      sources: completed.sources.filter(({ source }) => source === "releases"),
    },
  };
  expect(slice.progress.sources).toMatchObject([{ source: "releases", state: "read" }]);
  if (process.env.SPI_RECORD_RELEASE_FIXTURE === "1")
    writeFileSync(FIXTURE, `${JSON.stringify(slice, null, 2)}\n`);
  expect(slice).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
});
