// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

/** Record one live sweep of the public Azure fleet and its rib oracle:
 *   pnpm build && bun scripts/record-sweep.ts [--rib /tmp/rib-record] [--out <directory>]
 * The core Sweeper runs over HostExec with RecordingExec, a fixed clock and an empty cache, on
 * the fleet's public forks only: services.json pins them, and the core library joins the fleet's
 * release reads only when it is public. A fence refuses, without running it, any call that names
 * a repository, project or group not verified public, each checked when first named, and any
 * call whose shape the audit's grammar cannot read. The same log then replays through the
 * rib's Sweeper in a scratch checkout of keelson-rib-spi at RIB_REVISION, in a child bun
 * process with a clean environment, to give rib-facts.json. Every repository, project and group
 * a recorded call targets then has its visibility checked now, and the audit runs last.
 * Output goes to fixtures/exec/local/sweep-<date>/, which git ignores until D2 is decided; an
 * output directory that already holds anything is refused, never cleared.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import {
  CORE_LIB_REPO,
  fleetOf,
  KNOWN_SERVICES,
  STACK_REPO,
  TEMPLATE_REPO,
} from "../packages/core/src/config.js";
import { type CoreContext, createContext } from "../packages/core/src/context.js";
import type { ExecOptions, ExecOutput, ExecRunner } from "../packages/core/src/exec/port.js";
import type { ExecLogEntry } from "../packages/core/src/exec/recording.js";
import { RecordingExec } from "../packages/core/src/exec/recording.js";
import { AREAS, type Facts } from "../packages/core/src/facts.js";
import { createSweeper } from "../packages/core/src/sweep/areas.js";
import { HostExec } from "../packages/host/src/exec/host-exec.js";
import {
  auditSweep,
  callTargets,
  fenced,
  fenceMessage,
  GITHUB_HOST,
  LOG_FILE,
  NOT_PUBLIC,
  type References,
  report,
  scrubEmails,
  scrubJwts,
  sweepReferences,
  VISIBILITY_FILE,
  type Visibility,
  type VisibilityFile,
} from "./audit-exec-log.js";

export const RIB_REVISION = "59d6895";
export const META_FILE = "meta.json";
export const RIB_FACTS_FILE = "rib-facts.json";
export const ORACLE_FILE = "oracle.json";
export const SERVICES_FILE = "services.json";
const GITLAB = "community.opengroup.org";
const root = fileURLToPath(new URL("../", import.meta.url));

export interface SweepMeta {
  recordedAt: string;
  ribRevision: string;
  bun: string;
  entries: number;
  emailsScrubbed: number;
  jwtsScrubbed: number;
  failures: number;
  fleetFiles: { services: string };
  /** The core library the sweep read releases of; null when it was not public. */
  coreLib: string | null;
  excluded: Record<string, Visibility>;
  /** Calls the fence refused, by the repository, project or command it named. */
  fenced: Record<string, number>;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export const factsSchema = z.custom<Facts>(
  (value) => !!value && typeof value === "object" && AREAS.every((area) => area in value),
);

async function pool<T>(items: readonly T[], size: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await work(items[next++] as T);
    }),
  );
}

// What the managed sweep removes from the environment (packages/host/src/env/
// shell-environment.ts), and GITLAB_HOST: visibility is checked on the host and account the
// sweep reads.
const UNMANAGED = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "COPILOT_GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_HOST",
  "GH_CONFIG_DIR",
  "GITLAB_HOST",
]);

export function managedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !UNMANAGED.has(name.toUpperCase())),
  );
}

function githubVisibility(name: string): Visibility {
  try {
    const out = execFileSync(
      "gh",
      [
        "api",
        "--hostname",
        GITHUB_HOST,
        `repos/${name}`,
        "--jq",
        '.visibility // (if .private then "private" else "public" end)',
      ],
      {
        encoding: "utf8",
        env: managedEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      },
    ).trim();
    return out === "public" || out === "private" || out === "internal" ? out : "unknown";
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    return /HTTP 404|Not Found/i.test(stderr) ? "missing" : "unknown";
  }
}

async function gitlabVisibility(
  path: string,
  kind: "projects" | "groups" = "projects",
): Promise<Visibility> {
  const encoded = encodeURIComponent(path);
  const anonymous = await fetch(`https://${GITLAB}/api/v4/${kind}/${encoded}`).catch(
    () => undefined,
  );
  if (anonymous?.ok) {
    const body = (await anonymous.json()) as { visibility?: string };
    return body.visibility === undefined || body.visibility === "public" ? "public" : "unknown";
  }
  if (anonymous?.status !== 404) return "unknown";
  try {
    const out = execFileSync("glab", ["api", "--hostname", GITLAB, `${kind}/${encoded}`], {
      encoding: "utf8",
      env: managedEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    const visibility = (JSON.parse(out) as { visibility?: string }).visibility;
    return visibility === "private" || visibility === "internal" ? visibility : "unknown";
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    return /404|Not Found/i.test(stderr) ? "missing" : "unknown";
  }
}

/** The visibility now of every repository, project and group a recorded call targets, fenced
 * calls included. */
async function checkVisibility(out: string, now: Date): Promise<VisibilityFile> {
  const refs = sweepReferences(out);
  const seen = async (names: Set<string>, check: (name: string) => Promise<Visibility>) => {
    const found: Record<string, Visibility> = {};
    await pool([...names].sort(), 6, async (name) => {
      found[name] = await check(name);
    });
    return Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b)));
  };
  return {
    checkedAt: now.toISOString(),
    github: await seen(refs.github, async (name) => githubVisibility(name)),
    gitlab: await seen(refs.gitlab, (path) => gitlabVisibility(path)),
    gitlabGroups: await seen(refs.gitlabGroups, (path) => gitlabVisibility(path, "groups")),
  };
}

function tokens(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => /TOKEN/.test(entry[0]) && !!entry[1],
    ),
  );
}

export type Forge = keyof References;
const FORGE_NAMES: readonly Forge[] = ["github", "gitlab", "gitlabGroups"];

/** The visibility now of one GitHub repository, GitLab project or GitLab group. */
export type CheckVisibility = (forge: Forge, name: string) => Promise<Visibility>;

const liveVisibility: CheckVisibility = async (forge, name) =>
  forge === "github"
    ? githubVisibility(name)
    : gitlabVisibility(name, forge === "gitlab" ? "projects" : "groups");

/** Checks each name once, whatever its case; a check that fails leaves the name unknown. */
export function onceEach(check: CheckVisibility): CheckVisibility {
  const seen = new Map<string, Promise<Visibility>>();
  return (forge, name) => {
    const key = `${forge}:${name.toLowerCase()}`;
    let found = seen.get(key);
    if (!found) {
      found = check(forge, name).catch((): Visibility => "unknown");
      seen.set(key, found);
    }
    return found;
  };
}

/** Runs a call only when the audit can read its shape and every repository, project and group
 * it names is verified public; anything else is refused without running. */
export function fence(
  runner: ExecRunner,
  check: CheckVisibility,
  refused: Record<string, number>,
): ExecRunner {
  return async (cmd: string, args: string[], opts: ExecOptions): Promise<ExecOutput> => {
    const targets = callTargets(cmd, args);
    const refuse = (what: string, why: string): ExecOutput => {
      refused[what] = (refused[what] ?? 0) + 1;
      return { stdout: "", stderr: fenceMessage(what, why), exit: 1 };
    };
    if (!targets || opts.stdin) return refuse(cmd, "call of a shape the audit cannot read");
    for (const forge of FORGE_NAMES) {
      for (const name of [...targets[forge]].sort()) {
        if ((await check(forge, name)) !== "public") return refuse(name, NOT_PUBLIC);
      }
    }
    return runner(cmd, args, opts);
  };
}

/** The fleet's services whose fork is public now; the template and stack must be. */
async function publicFleet(check: CheckVisibility): Promise<{
  services: (typeof KNOWN_SERVICES)[number][];
  excluded: Record<string, Visibility>;
}> {
  const repos = [
    TEMPLATE_REPO,
    STACK_REPO,
    ...KNOWN_SERVICES.flatMap((s) => (s.repo ? [s.repo] : [])),
  ];
  const seen: Record<string, Visibility> = {};
  for (const repo of repos) seen[repo] = await check("github", repo);
  const excluded = Object.fromEntries(Object.entries(seen).filter(([, v]) => v !== "public"));
  if (excluded[TEMPLATE_REPO] || excluded[STACK_REPO])
    throw new Error(`the template and stack must be public: ${JSON.stringify(excluded)}`);
  return { services: KNOWN_SERVICES.filter((s) => !s.repo || seen[s.repo] === "public"), excluded };
}

/** Makes the output directory, refusing one that already holds anything: a recording never
 * deletes what it did not write. */
export function prepareOut(out: string): void {
  if (existsSync(out) && readdirSync(out).length)
    throw new Error(`${out} is not empty; remove it or pass another --out`);
  mkdirSync(out, { recursive: true });
}

export interface RecordOptions {
  out: string;
  /** Runs one call; the fence decides whether it is asked to. */
  runner: ExecRunner;
  check: CheckVisibility;
  now: Date;
  /** Values RecordingExec redacts beyond core's own patterns. */
  secrets: Record<string, string>;
  bun: string;
}

/** Records one sweep of the public fleet into an empty directory: services.json, exec.jsonl,
 * core-facts.json and meta.json. The core library is read only when it is public. */
export async function recordSweep(options: RecordOptions): Promise<{
  meta: SweepMeta;
  ctx: CoreContext;
  facts: Facts;
}> {
  const { out, now } = options;
  prepareOut(out);
  const clock = { now: () => now };
  const lines: string[] = [];
  const counts = { emails: 0, jwts: 0 };
  const refused: Record<string, number> = {};
  const check = onceEach(options.check);
  const { services, excluded } = await publicFleet(check);
  const library = await check("github", CORE_LIB_REPO);
  const coreLib = library === "public" ? CORE_LIB_REPO : null;
  if (!coreLib) excluded[CORE_LIB_REPO] = library;
  writeJson(join(out, SERVICES_FILE), services);
  const exec = new RecordingExec(
    fence(options.runner, check, refused),
    (jsonl) => {
      const line = jsonl.replace(/\n$/, "");
      const emails = scrubEmails(line);
      if (emails !== line) counts.emails++;
      const jwts = scrubJwts(emails);
      if (jwts !== emails) counts.jwts++;
      lines.push(`${jwts}\n`);
    },
    options.secrets,
  );
  const ctx = createContext({ clock, fleet: fleetOf(services, STACK_REPO, coreLib) });
  const sweeper = createSweeper({
    ctx,
    exec,
    persist: { load: async () => undefined, save: async () => {} },
    fleetFiles: { services: SERVICES_FILE },
    readFile: (path) => readFileSync(join(out, path), "utf8"),
    factsSchema,
  });
  await sweeper.sweep({ force: true });
  writeFileSync(join(out, LOG_FILE), lines.join(""));
  writeJson(join(out, "core-facts.json"), sweeper.facts);
  const entries = lines.map((line) => JSON.parse(line) as ExecLogEntry);
  const meta: SweepMeta = {
    recordedAt: now.toISOString(),
    ribRevision: RIB_REVISION,
    bun: options.bun,
    entries: entries.length,
    emailsScrubbed: counts.emails,
    jwtsScrubbed: counts.jwts,
    failures: entries.filter((e) => e.error !== undefined || e.exit !== 0).length,
    fleetFiles: { services: SERVICES_FILE },
    coreLib,
    excluded,
    fenced: refused,
  };
  writeJson(join(out, META_FILE), meta);
  return { meta, ctx, facts: sweeper.facts };
}

async function record(out: string, rib: string): Promise<void> {
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const appData = mkdtempSync(join(tmpdir(), "spi-code-record-"));
  try {
    const host = new HostExec({
      appData,
      capturedPath: process.env.PATH ?? "",
      installer: { binDir: async () => undefined },
    });
    const { meta, facts } = await recordSweep({
      out,
      runner: host.run,
      check: liveVisibility,
      now,
      secrets: tokens(),
      bun: execFileSync("bun", ["--version"], { encoding: "utf8" }).trim(),
    });
    console.log(
      `recorded ${meta.entries} calls (${meta.failures} failed, ${Object.values(meta.fenced).reduce((a, b) => a + b, 0)} fenced; ` +
        `scrubbed ${meta.emailsScrubbed} with emails, ${meta.jwtsScrubbed} with JWTs)` +
        `; core library ${meta.coreLib ? "read" : "left out"}` +
        `; areas with errors: ${AREAS.filter((a) => facts[a].error).join(", ") || "none"}`,
    );
  } finally {
    rmSync(appData, { recursive: true, force: true });
  }
  oracle(out, rib);
  writeJson(join(out, VISIBILITY_FILE), await checkVisibility(out, now));
  const result = auditSweep(out);
  console.log(report(out, result));
  if (result.findings.length) process.exitCode = 1;
}

function oracle(out: string, rib: string): void {
  const revision = execFileSync("git", ["-C", rib, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (!revision.startsWith(RIB_REVISION))
    throw new Error(`${rib} is at ${revision}, not ${RIB_REVISION}`);
  if (execFileSync("git", ["-C", rib, "status", "--porcelain"], { encoding: "utf8" }).trim())
    throw new Error(`${rib} has local changes`);
  const temporary = mkdtempSync(join(tmpdir(), "spi-code-rib-record-"));
  try {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("RIB_SPI_") || key.startsWith("KEELSON_")) delete env[key];
    }
    execFileSync("bun", [fileURLToPath(import.meta.url), "--oracle", rib, out], {
      cwd: out,
      stdio: "inherit",
      env: { ...env, KEELSON_HOME: join(temporary, "home"), TZ: "UTC" },
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const RUNS_WRAPPER = /^\{total: \.total_count, (\w+): (.*)\}$/s;
const QUERY_ADDITIONS = [
  /spicodeBudget:rateLimit\{costremainingresetAt\}/g,
  /rateLimit\{costremainingresetAt\}/g,
  /pageInfo\{hasNextPage(?:endCursor)?\}/g,
  /totalCount/g,
  /merged:<=\d{4}-\d{2}-\d{2}/g,
];
const PATH = /^(?:repos|projects)\//;
const VARIABLES = /\/actions\/variables\?/;
const NO_COMMITS = ", commits: []}";
const TOTAL_COMMITS = "total_commits, ";

function pathOf(args: readonly string[]): string | undefined {
  return args.find((arg) => PATH.test(arg));
}

function perPage(args: readonly string[]): number | undefined {
  const value = /[?&]per_page=(\d+)/.exec(pathOf(args) ?? "")?.[1];
  return value === undefined ? undefined : Number(value);
}

/** One call as either side asks it, with core's changes since the rib taken out, so both
 * sides key the same read the same way. Each rule names a read that returns the same data:
 * - GraphQL: the budget alias core adds to every GitHub query and the rib's own rateLimit
 *   (both read the same rateLimit object), the page and total fields core reads to mark a
 *   cut connection, and the merged-before bound that ends a ledger window today.
 * - REST lists: page size, `page=1`, `--paginate` and the `{total, <list>}` jq core uses to
 *   page; the rib reads the first page of the same list (ribStdout cuts it to the rib's size).
 * - Run jobs: core names the run's attempt, the rib's default filter is its latest attempt.
 * - Repository variables: core reads them whole, the rib selects two (ribStdout selects them).
 * - Compare: the rib asks an empty `commits` it never reads; core leaves it out. Core pages a
 *   full compare and reads `total_commits` to know when to stop; when one page holds every
 *   commit, it is the rib's unpaged compare (ribStdout refuses a longer one).
 * Later pages and core-only reads stay unused: they carry nothing the rib asks for. */
export function canonicalCall(cmd: string, args: readonly string[], stdin?: string | null): string {
  const out: string[] = [];
  const variables = VARIABLES.test(pathOf(args) ?? "");
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--paginate") continue;
    if (arg === "--jq" && variables) {
      i++;
      continue;
    }
    if (arg.startsWith("query=")) {
      let query = arg.slice("query=".length).replace(/\s+/g, "");
      for (const addition of QUERY_ADDITIONS) query = query.replace(addition, "");
      out.push(`query=${query}`);
      continue;
    }
    if (PATH.test(arg)) {
      out.push(
        arg
          .replace(/\/attempts\/\d+\/jobs\?/, "/jobs?")
          .replace(/([?&])(?:per_page=\d+|page=1)(?=&|$)/g, "$1")
          .replace(/&{2,}/g, "&")
          .replace(/\?&/, "?")
          .replace(/[?&]$/, ""),
      );
      continue;
    }
    if (args[i - 1] === "--jq") {
      const wrapped = RUNS_WRAPPER.exec(arg);
      let jq = wrapped ? (wrapped[2] as string) : arg;
      if (jq.endsWith(NO_COMMITS)) jq = `${jq.slice(0, -NO_COMMITS.length)}}`;
      jq = jq.replace(TOTAL_COMMITS, "");
      if (args.includes("--paginate") && !jq.startsWith("[")) jq = `[${jq}]`;
      out.push(jq);
      continue;
    }
    out.push(arg);
  }
  return JSON.stringify([cmd, out, stdin ?? null]);
}

/** The recorded output as the rib would have read it for its own form of the call. */
export function ribStdout(entry: ExecLogEntry, ribArgs: readonly string[]): string {
  if (entry.cmd !== "gh") return entry.stdout;
  const jq = entry.args.includes("--jq") ? entry.args[entry.args.indexOf("--jq") + 1] : undefined;
  if (entry.args.some((arg) => arg.startsWith("query="))) return ribGraphql(entry.stdout, ribArgs);
  if (VARIABLES.test(pathOf(entry.args) ?? "")) {
    const body = JSON.parse(entry.stdout) as { variables: { name: string; value: string }[] };
    return JSON.stringify(
      body.variables
        .filter((v) => v.name === "UPSTREAM_REPO_URL" || v.name === "SYNC_MODE")
        .map(({ name, value }) => ({ name, value })),
    );
  }
  if (jq?.includes(TOTAL_COMMITS) && !ribArgs.some((arg) => arg.includes(TOTAL_COMMITS))) {
    const body = JSON.parse(entry.stdout) as { total_commits: number; commits: unknown[] };
    if (body.total_commits > body.commits.length)
      throw new Error(
        `${pathOf(entry.args)}: core read ${body.commits.length} of ${body.total_commits} commits`,
      );
    const { total_commits: _total, ...rest } = body;
    return JSON.stringify(rest);
  }
  if (ribArgs.includes("--paginate")) return entry.stdout;
  let data: unknown;
  if (entry.args.includes("--paginate")) {
    data = entry.stdout
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => {
        const page = JSON.parse(line) as unknown;
        return jq?.startsWith("[") ? (page as unknown[]) : [page];
      });
  } else {
    const wrapped = jq === undefined ? null : RUNS_WRAPPER.exec(jq);
    if (!wrapped && !ribArgs.some((arg) => arg.endsWith(NO_COMMITS))) return entry.stdout;
    data = JSON.parse(entry.stdout) as unknown;
    if (wrapped) data = (data as Record<string, unknown>)[wrapped[1] as string];
    if (ribArgs.some((arg) => arg.endsWith(NO_COMMITS)))
      data = { ...(data as object), commits: [] };
  }
  if (Array.isArray(data)) {
    const ribSize = perPage(ribArgs) ?? 30;
    const coreSize = perPage(entry.args) ?? 30;
    // A complete core read is longer than one rib page only when core asked bigger pages.
    if (data.length > ribSize) {
      if (coreSize < ribSize && !entry.args.includes("--paginate"))
        throw new Error(`${pathOf(entry.args)}: core page is smaller than the rib's`);
      data = data.slice(0, ribSize);
    }
  }
  return JSON.stringify(data);
}

function ribGraphql(stdout: string, ribArgs: readonly string[]): string {
  try {
    const body = JSON.parse(stdout) as { data?: Record<string, unknown> };
    if (!body.data || !("spicodeBudget" in body.data)) return stdout;
    const asksRate = ribArgs.some(
      (arg) => arg.startsWith("query=") && /\brateLimit\s*\{/.test(arg),
    );
    if (asksRate && !("rateLimit" in body.data)) body.data.rateLimit = body.data.spicodeBudget;
    delete body.data.spicodeBudget;
    return JSON.stringify(body);
  } catch {
    return stdout;
  }
}

type RibResult<T> =
  | { ok: true; data: T; exitCode?: number | null }
  | { ok: false; error: string; code: number | null };

// Calls are matched by what they ask, first in first out: the rib reads areas concurrently.
async function replayRib(rib: string, out: string): Promise<void> {
  const meta = JSON.parse(readFileSync(join(out, META_FILE), "utf8")) as SweepMeta;
  const entries = readFileSync(join(out, LOG_FILE), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ExecLogEntry);
  const queues = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    const key = canonicalCall(entry.cmd, entry.args, entry.stdin);
    queues.set(key, [...(queues.get(key) ?? []), index]);
  });
  const used = new Set<number>();
  const served = new Map<string, number>();
  const missing: string[] = [];
  let repeated = 0;
  function runText(
    cmd: string,
    args: string[],
    opts: { acceptNonZeroExit?: boolean } = {},
  ): RibResult<string> {
    const key = canonicalCall(cmd, args);
    let index = queues.get(key)?.shift();
    // Both sides cache some reads per sweep and fill the cache from a pool, so how often a
    // read repeats depends on timing; a repeat at the same fixed instant returns the same data.
    if (index === undefined && served.has(key)) {
      index = served.get(key);
      repeated++;
    }
    if (index === undefined) {
      missing.push(`${cmd} ${JSON.stringify(args)}`.slice(0, 400));
      return { ok: false, error: `${cmd} not recorded`, code: null };
    }
    used.add(index);
    served.set(key, index);
    const entry = entries[index] as ExecLogEntry;
    if (entry.error !== undefined) return { ok: false, error: entry.error, code: entry.exit };
    const stdout = ribStdout(entry, args);
    if (entry.exit !== 0) {
      if (opts.acceptNonZeroExit && entry.exit !== null)
        return { ok: true, data: stdout, exitCode: entry.exit };
      const reason = entry.stderr
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      return { ok: false, error: (reason ?? `exit ${entry.exit}`).slice(0, 200), code: entry.exit };
    }
    return { ok: true, data: stdout, exitCode: 0 };
  }
  const exec = {
    runText: async (cmd: string, args: string[], opts?: { acceptNonZeroExit?: boolean }) =>
      runText(cmd, args, opts),
    runJSON: async <T>(
      cmd: string,
      args: string[],
      opts?: { acceptNonZeroExit?: boolean },
    ): Promise<RibResult<T>> => {
      const result = runText(cmd, args, opts);
      if (!result.ok) return result;
      const start = [...result.data].findIndex((ch) => ch === "{" || ch === "[");
      if (start < 0) return { ok: false, error: "no JSON found in output", code: null };
      try {
        return {
          ok: true,
          data: JSON.parse(result.data.slice(start)) as T,
          exitCode: result.exitCode ?? null,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: `invalid JSON: ${message}`.slice(0, 200), code: null };
      }
    },
  };
  const { Sweeper } = await import(pathToFileURL(join(rib, "src/sweep.ts")).href);
  const { Store } = await import(pathToFileURL(join(rib, "src/store.ts")).href);
  const now = new Date(meta.recordedAt);
  const sweeper = new Sweeper({
    exec,
    store: new Store(undefined),
    onChange() {},
    now: () => now,
    fleetFiles: meta.fleetFiles,
  });
  await sweeper.sweep({ force: true });
  writeJson(join(out, RIB_FACTS_FILE), sweeper.facts);
  // A fenced call read nothing; listing it would name the repository it refused.
  const refused = entries.filter((entry, index) => !used.has(index) && fenced(entry)).length;
  const unused = entries.flatMap((entry, index) =>
    used.has(index) || fenced(entry) ? [] : [`${entry.cmd} ${entry.args.join(" ")}`.slice(0, 200)],
  );
  writeJson(join(out, ORACLE_FILE), {
    ribRevision: RIB_REVISION,
    used: used.size,
    repeated,
    unused,
    fenced: refused,
    missing,
  });
  console.log(
    `rib oracle: ${used.size} of ${entries.length} recorded calls used, ` +
      `${repeated} repeated, ${unused.length} unused, ${refused} fenced and unused, ${missing.length} not recorded`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--oracle") {
    const [rib, out] = process.argv.slice(3);
    if (!rib || !out) throw new Error("usage: --oracle <rib checkout> <sweep directory>");
    await replayRib(resolve(rib), resolve(out));
  } else {
    const date = new Date().toISOString().slice(0, 10);
    const out = resolve(option("--out") ?? join(root, "fixtures/exec/local", `sweep-${date}`));
    await record(out, resolve(option("--rib") ?? "/tmp/rib-record"));
  }
}
