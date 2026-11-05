// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

/** Generate separately from Vitest: bun scripts/rib-oracle.ts [read-only rib path].
 * Requires installed pnpm dependencies and the Bun version in
 * packages/core/test/fixtures/rib-59d6895/render.json.
 * Clones the pinned rib into a disposable scratch checkout; no forge calls are allowed.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FAILURE_CLASSES = [
  "ENV",
  "ACCESS",
  "TEST",
  "HALT",
  "TOOLCHAIN",
  "CONFLICT",
  "POLICY",
  "INFRA",
  "BUILD",
  "UNREAD",
] as const;
const payloads = [
  "briefing.json",
  "releases.json",
  "lines.json",
  "environment-place.json",
  "console.html",
  ...FAILURE_CLASSES.map((cls) => `inspect/${cls}.json`),
].sort();
const root = fileURLToPath(new URL("../", import.meta.url));
const inputs = join(root, "packages/core/test/fixtures/rib-59d6895");
const destination = join(root, "fixtures/rib-59d6895/oracle");

interface Settings {
  revision: string;
  bun: string;
  now: string;
  timezone: string;
  locale: string;
  months: number;
  reading: boolean;
  facts: string;
  releases: string;
  services: string;
  rollout: string;
  notes: string;
}
interface Manifest {
  revision: string;
  bun: string;
  now: string;
  timezone: string;
  locale: string;
  files: Record<string, string>;
}
function read<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8"));
}
function json(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const formatted = execFileSync(
    "pnpm",
    ["exec", "biome", "format", "--stdin-file-path=oracle.json"],
    {
      cwd: root,
      input: `${JSON.stringify(value, null, 2)}\n`,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  writeFileSync(path, formatted);
}
function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
export function verifyOracle(directory: string): Manifest {
  const manifest = read<Manifest>(join(directory, "manifest.json"));
  const settings = read<Settings>(join(inputs, "render.json"));
  for (const key of ["revision", "bun", "now", "timezone", "locale"] as const) {
    assert.equal(manifest[key], settings[key], `Pinned ${key} differs`);
  }
  assert.deepEqual(Object.keys(manifest.files).sort(), payloads, "Payload list differs");
  for (const name of payloads) {
    assert.match(manifest.files[name] ?? "", /^[a-f0-9]{64}$/);
    assert.equal(hash(join(directory, name)), manifest.files[name], `Hash differs: ${name}`);
  }
  return manifest;
}
function repositoryState(path: string) {
  const git = (args: string[]) => execFileSync("git", ["-C", path, ...args], { encoding: "utf8" });
  return { status: git(["status", "--porcelain"]), worktrees: git(["worktree", "list"]) };
}

async function render(scratch: string, output: string) {
  const settings = read<Settings>(join(inputs, "render.json"));
  assert.equal(process.env.TZ, settings.timezone);
  assert.equal(new Intl.DateTimeFormat().resolvedOptions().locale, settings.locale);
  const now = new Date(settings.now);
  const module = (name: string) => import(pathToFileURL(join(scratch, name)).href);
  const bunModule = "bun";
  const { plugin } = await import(bunModule);
  // place() is private. Expose it only in memory, retaining the pinned source bytes on disk.
  plugin({
    name: "oracle-place",
    setup(build: {
      onLoad: (filter: { filter: RegExp }, load: (args: { path: string }) => unknown) => void;
    }) {
      build.onLoad({ filter: /[/\\]src[/\\]boards[/\\]console\.ts$/ }, ({ path }) => ({
        contents: `${readFileSync(path, "utf8")}\nexport { place };`,
        loader: "ts",
      }));
    },
  });
  const { Sweeper } = await module("src/sweep.ts");
  const { Store } = await module("src/store.ts");
  const { doctorStatus } = await module("src/boards/doctor.ts");
  const { buildBriefing } = await module("src/brief/index.ts");
  const { consoleHtml, expectHtml, place } = await module("src/boards/console.ts");
  const { monthFacts, releaseMonths } = await module("src/model/releases.ts");
  const { releaseDoc, releaseLine } = await module("src/brief/release.ts");
  const { readNotes } = await module("src/notes/file.ts");
  const { LINE_COLUMNS } = await module("src/brief/upstream.ts");
  const { inspectBoard } = await module("src/boards/inspect.ts");
  const unreachable = () => {
    throw new Error("Oracle rendering must not call a forge");
  };
  const sweeper = new Sweeper({
    exec: { runJSON: unreachable, runText: unreachable },
    store: new Store(undefined),
    now: () => now,
    onChange: () => {},
  });
  const model = sweeper.model;
  const briefing = buildBriefing(model, doctorStatus(sweeper.facts, now), now);
  const reads = read(join(inputs, settings.releases));
  const months: string[] = releaseMonths(reads, now);
  const releases = {
    lines: months.slice(0, settings.months).map((month) => {
      const notes = readNotes(join(inputs, settings.notes), month);
      assert.notEqual(notes.state, "invalid", `Invalid notes for ${month}`);
      return releaseLine(releaseDoc(monthFacts(reads, month, now), notes, now));
    }),
    reading: settings.reading,
  };
  json(join(output, "briefing.json"), briefing);
  json(join(output, "releases.json"), releases);
  json(join(output, "lines.json"), {
    columns: LINE_COLUMNS,
    flow: briefing.flow.rows.map((row: { fork: string; line: unknown[] }) => {
      assert.equal(row.line.length, LINE_COLUMNS.length);
      return { fork: row.fork, line: row.line };
    }),
    services: model.lines.map((line: { fork: { id: string }; stations: { id: string }[] }) => {
      assert.deepEqual(
        line.stations.map((station) => station.id),
        ["upstream", "sync", "cascade", "main", "release", "lane"],
      );
      return { fork: line.fork.id, stations: line.stations };
    }),
  });
  const env = briefing.environment;
  json(join(output, "environment-place.json"), {
    from: env.from,
    to: env.to,
    lanes: env.lanes.map((lane: { id: string; events: unknown[] }) => ({
      id: lane.id,
      placed: place(lane.events, Date.parse(env.from), Date.parse(env.to)),
    })),
  });
  const html = expectHtml(consoleHtml(briefing, now, releases));
  assert.equal(
    html,
    readFileSync(join(inputs, "console.html"), "utf8"),
    "Baseline console differs",
  );
  writeFileSync(join(output, "console.html"), html);

  // The class rows and item defaults are from test/next.test.ts at the pinned revision.
  // POLICY, INFRA and UNREAD lack dedicated rib test rows; use its generic gate1 state.
  const overrides = {
    ENV: { kind: "lanes" },
    ACCESS: {
      kind: "access",
      cause: [
        { label: "reason", value: 'denied: "ghcr.io/azure/osdu-spi-legal:pr-9" requires auth' },
      ],
    },
    TEST: {
      kind: "template-red",
      cause: [{ label: "reason", value: "failed suites: acceptance" }],
    },
    HALT: {
      kind: "halt",
      rung: 0,
      halt: { fork: "entitlements", code: "UNKNOWN_TOP_LEVEL", entries: ["schemathesis-tests"] },
    },
    TOOLCHAIN: {
      cause: [
        {
          label: "reason",
          value: "RequireJavaVersion: JDK 17.0.20-1 is outside the allowed range [25,)",
        },
      ],
    },
    CONFLICT: { kind: "conflict", rung: 0 },
    BUILD: {
      kind: "release-red",
      cause: [{ label: "check", value: "Java Build › Run Java Build" }],
    },
    POLICY: {},
    INFRA: {},
    UNREAD: {},
  };
  for (const cls of FAILURE_CLASSES) {
    const item = {
      id: "x",
      kind: "gate1",
      rung: 1,
      scope: "svc",
      text: "",
      effects: [],
      cause: [],
      incident: true,
      blocks: 1,
      cls,
      ...overrides[cls],
    };
    const state = { selected: item.id, item };
    const board = inspectBoard({ ...model, queue: { ...model.queue, items: [item] } }, state, now);
    assert.equal(board.header.status.label, `P${item.rung} · ${cls}`);
    json(join(output, `inspect/${cls}.json`), board);
  }
  json(join(output, "manifest.json"), {
    revision: settings.revision,
    bun: settings.bun,
    now: settings.now,
    timezone: settings.timezone,
    locale: settings.locale,
    files: Object.fromEntries(payloads.map((name) => [name, hash(join(output, name))])),
  });
  verifyOracle(output);
}

export async function generate(rib: string) {
  const settings = read<Settings>(join(inputs, "render.json"));
  const before = repositoryState(rib);
  console.log("BEFORE", JSON.stringify(before));
  const temporary = mkdtempSync(join(tmpdir(), "spi-code-rib-oracle-"));
  try {
    const scratch = join(temporary, "rib");
    const output = join(temporary, "output");
    mkdirSync(output);
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("RIB_SPI_") || key.startsWith("KEELSON_")) delete env[key];
    }
    mkdirSync(join(temporary, "home"));
    mkdirSync(join(temporary, "tmp"));
    Object.assign(env, {
      TZ: settings.timezone,
      LC_ALL: "C",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      KEELSON_HOME: join(temporary, "home"),
      TMPDIR: join(temporary, "tmp"),
      RIB_SPI_FACTS_FILE: join(inputs, settings.facts),
      RIB_SPI_SERVICES_FILE: join(inputs, settings.services),
      RIB_SPI_ROLLOUT_FILE: join(inputs, settings.rollout),
      RIB_SPI_NOTES_DIR: join(inputs, settings.notes),
    });
    const options = { env, encoding: "utf8" as const, maxBuffer: 16 * 1024 * 1024 };
    assert.equal(execFileSync("bun", ["--version"], options).trim(), settings.bun);
    execFileSync(
      "git",
      ["clone", "--quiet", "--no-hardlinks", "--no-checkout", rib, scratch],
      options,
    );
    execFileSync(
      "git",
      ["-C", scratch, "checkout", "--quiet", "--detach", settings.revision],
      options,
    );
    assert.equal(
      execFileSync("git", ["-C", scratch, "rev-parse", "HEAD"], options).trim(),
      settings.revision,
    );
    execFileSync("bun", ["install", "--frozen-lockfile"], { ...options, cwd: scratch });
    execFileSync("bun", [fileURLToPath(import.meta.url), "--render", scratch, output], options);
    cpSync(output, destination, { recursive: true });
    console.log(JSON.stringify(verifyOracle(destination), null, 2));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    const after = repositoryState(rib);
    console.log("AFTER", JSON.stringify(after));
    assert.deepEqual(after, before, "Read-only rib status or worktrees changed");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--render") {
    assert.ok(process.argv[3] && process.argv[4], "Pass scratch checkout and output directory");
    await render(process.argv[3], process.argv[4]);
  } else {
    await generate(process.argv[2] ?? "/Users/danielscholl/keelson/keelson-rib-spi");
  }
}
