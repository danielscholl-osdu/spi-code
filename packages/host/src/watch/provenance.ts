// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { AreaEnvelope, Envelope, ReleasesToday, ValueSource } from "@spi-code/contracts";
import {
  AREAS,
  type AreaName,
  type Briefing,
  envelopeOf,
  RELEASES_EVERY_MS,
  type ReadRecord,
  type StackModel,
} from "@spi-code/core";

// Each binding names the Facts areas core read to build the value, per branch where the branch
// changes what was read (see buildLine, buildStack, buildUpstream, buildRepos). A value drawn
// only from inferred areas must read as inferred (EV-03), so a binding never names an area that
// did not feed it. A value that reads the whole model, or a label or branch this file does not
// know, falls back to a superset: under-naming would hide a stale or failed input.
/** One read, as core's facts name it. */
const GITHUB = ["github"] as const satisfies readonly AreaName[];
/** Replayed lifecycle runs: maintenance, availability, proof runs and lane events. */
const LIFECYCLE = ["lifecycle"] as const satisfies readonly AreaName[];
/** Pull requests and issues (github) with the fork's workflow runs and their jobs (runs). */
const GITHUB_RUNS = ["github", "runs"] as const satisfies readonly AreaName[];
/** buildStack: the stack repository and fork deployments (github) and lifecycle runs. */
const STACK = ["github", "lifecycle"] as const satisfies readonly AreaName[];
/** A fork's flow phase (buildUpstream's forkOf): PRs and issues, runs, lag and the radar. */
const PHASE = [...GITHUB_RUNS, "upstream", "radar"] as const satisfies readonly AreaName[];
/** The flow plan adds the stack hold (lifecycle) to the phases and the lane load (github, runs). */
const FLOW = [...PHASE, "lifecycle"] as const satisfies readonly AreaName[];
/** Alert groups (security) owned through the radar's filters and the template's synced paths. */
const ALERTS = ["radar", "template", "security"] as const satisfies readonly AreaName[];
/** A repository row: PRs and issues (github) beside its owned alert groups. */
const REPO = [...GITHUB, ...ALERTS] as const satisfies readonly AreaName[];
/** buildLine: repositories, fork runs, upstream, template compares, job details, radar and the stack. */
const LINES = [...FLOW, "template", "details"] as const satisfies readonly AreaName[];
/** buildQueue and themes read the whole model, which adds approvals and security alerts. */
const MODEL = [...LINES, "approvals", "security"] as const satisfies readonly AreaName[];

/**
 * The environment figure is the running version (lifecycle). The declared one (github) is
 * reached only when lifecycle found no running version, so by precedence it binds both.
 */
function versionAreas(stack: StackModel): readonly AreaName[] {
  return stack.running ? LIFECYCLE : STACK;
}

function briefFactAreas(label: string, stack: StackModel): readonly AreaName[] {
  if (label === "Environment") return versionAreas(stack);
  // Stopped pills: main red (runs, details), halts and cascade stops (github), template
  // deliveries (runs) and compares (template), and failing sync or template PRs (github, details).
  if (label === "Upstream sync") return ["github", "runs", "details", "template"];
  // Forks whose marker (github) compares (template) at zero behind, of those read.
  if (label.startsWith("Template")) return ["github", "template"];
  return MODEL;
}

function environmentFactAreas(label: string, stack: StackModel): readonly AreaName[] {
  if (label === "Running") return versionAreas(stack);
  if (label.startsWith("Deployable") || label === "Last proof") return LIFECYCLE;
  return MODEL;
}

function repositoryFactAreas(label: string): readonly AreaName[] {
  if (label === "Issues" || label === "Pull Requests" || label === "Dependabot Bumps")
    return GITHUB;
  if (label.endsWith("· ours")) return ALERTS;
  return MODEL;
}

function flowTileAreas(label: string): readonly AreaName[] {
  if (label === "Behind upstream") return ["upstream"];
  if (label === "Lanes") return GITHUB_RUNS;
  // A fork is stopped on a conflict issue or stop label with no cascade PR open: github alone.
  if (label === "Stopped") return GITHUB;
  if (["Toolchain move", "Will halt", "On main"].includes(label)) return PHASE;
  // "Waiting on you" counts presses that fit the lanes and the stack hold, so it reads FLOW.
  return FLOW;
}

const REPO_CELLS = {
  changes: GITHUB,
  dependabot: GITHUB,
  issues: GITHUB,
  vulnerabilities: ALERTS,
  codeScanning: ALERTS,
} as const satisfies Record<string, readonly AreaName[]>;

function ordered(areas: readonly AreaName[]): AreaName[] {
  return AREAS.filter((area) => areas.includes(area));
}

/**
 * The areas buildLine read for a station, by station and by the branch that produced its text.
 * buildLine tries branches in precedence order, so a later branch also binds the areas whose
 * absence let core reach it: "held" is a label (github) read once no cascade runs (runs), and a
 * plain "N behind" means neither a halt or sync PR (github) nor a radar verdict was read.
 * An unrecognised branch takes the union of that station's branches.
 */
export function stationAreas(station: { id: string; state: string; text: string }): AreaName[] {
  const { id, state, text } = station;
  switch (id) {
    case "upstream":
      // Lag alone, or lag with the halt or sync PR (github) and the radar's verdict.
      return ordered(state === "waiting" ? ["github", "upstream", "radar"] : ["upstream"]);
    case "sync":
      // A halt issue or the sync PR (github); otherwise the last Sync Upstream run (runs).
      return ordered(/^(halted: |PR #)/.test(text) ? GITHUB : GITHUB_RUNS);
    case "cascade":
      // Conflict issues and stop labels (github); otherwise also a running cascade (runs).
      return ordered(state === "stopped" ? GITHUB : GITHUB_RUNS);
    case "main":
      // The cascade PR (github); otherwise also the proving main run and its jobs (runs).
      return ordered(text.startsWith("PR #") ? GITHUB : GITHUB_RUNS);
    case "release":
      // The release PR or the latest release tag, both github.
      return ordered(GITHUB);
    case "lane":
      // A held stack (lifecycle); otherwise also the fork's deployments (github).
      return ordered(text === "blocked by the stack" ? LIFECYCLE : STACK);
    default:
      return ordered(LINES);
  }
}

/** Provenance for every briefing value the Watch views draw, keyed by RFC 6901 pointer. */
export function briefingProvenance(briefing: Briefing, stack: StackModel): ValueSource[] {
  const sources: ValueSource[] = [];
  const add = (path: string, areas: readonly AreaName[]): void => {
    sources.push({ path, areas: ordered(areas) });
  };
  const each = (items: readonly unknown[], prefix: string, areas: readonly AreaName[]): void => {
    for (const i of items.keys()) add(`${prefix}/${i}`, areas);
  };
  // The headline, summary, focus queue, ready line, themes and horizon read buildQueue and
  // themes, which judge every area together.
  add("/briefing/headline", MODEL);
  add("/briefing/summary", MODEL);
  add("/briefing/more", MODEL);
  if ("since" in briefing && briefing.since) add("/briefing/since", ["runs", "github", "template"]);
  for (const [i, fact] of briefing.facts.entries()) {
    add(`/briefing/facts/${i}/figure`, briefFactAreas(fact.label, stack));
  }
  each(briefing.focus, "/briefing/focus", MODEL);
  each(briefing.rest, "/briefing/rest", MODEL);
  each(briefing.ready, "/briefing/ready", MODEL);
  each(briefing.themes, "/briefing/themes", MODEL);
  add("/briefing/horizon/headline", MODEL);

  const { flow } = briefing;
  add("/briefing/flow/mode", PHASE);
  add("/briefing/flow/headline", FLOW);
  add("/briefing/flow/sub", FLOW);
  for (const [i, tile] of flow.tiles.entries()) {
    add(`/briefing/flow/tiles/${i}`, flowTileAreas(tile.label));
  }
  // A row's next step and wave depend on every fork's phase, the lane load and the stack hold.
  each(flow.rows, "/briefing/flow/rows", FLOW);
  add("/briefing/flow/plan", FLOW);
  if (flow.schedule) add("/briefing/flow/schedule", FLOW);
  add("/briefing/flow/next", FLOW);
  each(flow.also, "/briefing/flow/also", FLOW);

  const { environment } = briefing;
  add("/briefing/environment/headline", LIFECYCLE);
  for (const [i, fact] of environment.facts.entries()) {
    add(`/briefing/environment/facts/${i}/figure`, environmentFactAreas(fact.label, stack));
  }
  each(environment.lanes, "/briefing/environment/lanes", LIFECYCLE);
  // Fork lane deploys per day come from the forks' github deployments.
  if (environment.note !== undefined) add("/briefing/environment/note", GITHUB);

  const { repositories } = briefing;
  // The headline names the first critical alert group SPI owns, or that alerts are unread.
  add("/briefing/repositories/headline", ALERTS);
  for (const [i, fact] of repositories.facts.entries()) {
    add(`/briefing/repositories/facts/${i}/figure`, repositoryFactAreas(fact.label));
  }
  for (const i of repositories.rows.keys()) {
    add(`/briefing/repositories/rows/${i}`, REPO);
    for (const [cell, areas] of Object.entries(REPO_CELLS)) {
      add(`/briefing/repositories/rows/${i}/cells/${cell}`, areas);
    }
  }
  return sources;
}

/** Stations come from buildLine, one row per fork; each binds to the branch that drew it. */
export function stationProvenance(
  stations: readonly {
    readonly stations: readonly { id: string; state: string; text: string }[];
  }[],
): ValueSource[] {
  return stations.flatMap((row, s) =>
    row.stations.map((station, k) => ({
      path: `/stations/${s}/stations/${k}`,
      areas: stationAreas(station),
    })),
  );
}

/**
 * The month ledger and each line bind the release ledger and fleet, even when no lines exist.
 * The ledger binds at /releases/lines, not /releases, so Today and forming values beside it
 * inherit nothing from it.
 */
export function releaseProvenance(
  lines: readonly unknown[],
  records: readonly ReadRecord[],
  now: Date,
): ValueSource[] {
  const envelope = readEnvelope("releases", records, RELEASES_EVERY_MS, now);
  return [
    ...lines.map<ValueSource>((_, i) => ({
      path: `/releases/lines/${i}`,
      areas: ["fleet"],
      envelope,
    })),
    { path: "/releases/lines", areas: ["fleet"], envelope },
  ];
}

/** Which read gave a platform version: the release ledger, or a GitHub release tag where the ledger had none. */
export type PlatformSource = "ledger" | "github";

/**
 * Today's release fields, each bound to the reads that built it: versions and core-lib-azure
 * pins to the release ledger and fleet, proposed versions and release PRs to GitHub, and the
 * ready line to GitHub and job details. A platform version whose source is not given has no
 * binding rather than a guessed one.
 */
export function releasesTodayProvenance(
  today: ReleasesToday | undefined,
  records: readonly ReadRecord[],
  now: Date,
  platform: { readonly stack?: PlatformSource; readonly template?: PlatformSource } = {},
): ValueSource[] {
  if (!today) return [];
  type Binding = Omit<ValueSource, "path">;
  const envelope = readEnvelope("releases", records, RELEASES_EVERY_MS, now);
  const ledger: Binding = { areas: ["fleet"], envelope };
  const withGithub: Binding = { areas: ["fleet", "github"], envelope };
  const github: Binding = { areas: ["github"] };
  const fromPlatform = (source: PlatformSource | undefined) =>
    source === "ledger" ? ledger : source === "github" ? withGithub : undefined;
  const out: ValueSource[] = [];
  const bind = (path: string, source: Binding | undefined) => {
    if (source) out.push({ path: `/releases/today${path}`, ...source });
  };
  for (const [i, version] of today.versions.entries()) {
    const at = `/versions/${i}`;
    bind(`${at}/service`, ledger);
    bind(`${at}/released`, ledger);
    if (version.coreLibAzure !== undefined) bind(`${at}/coreLibAzure`, ledger);
    if (version.proposed !== undefined) bind(`${at}/proposed`, github);
    if (version.pr) bind(`${at}/pr`, github);
    bind(`${at}/text`, version.proposed === undefined ? ledger : withGithub);
  }
  const { stack, template, coreLibAzure } = today.platform;
  const stackSource = stack === undefined ? undefined : fromPlatform(platform.stack);
  const templateSource = template ? fromPlatform(platform.template) : undefined;
  bind("/platform/stack", stackSource);
  bind("/platform/template/released", templateSource);
  if (template?.proposed !== undefined) bind("/platform/template/proposed", github);
  if (template?.pr) bind("/platform/template/pr", github);
  bind("/platform/coreLibAzure", ledger);
  const parts = [
    ...(stack === undefined ? [] : [stackSource]),
    ...(template ? [templateSource, ...(template.proposed === undefined ? [] : [github])] : []),
    ...(coreLibAzure.length > 0 ? [ledger] : []),
  ];
  if (parts.length === 0) bind("/platform/text", ledger);
  else if (parts.every((part) => part !== undefined)) {
    bind("/platform/text", {
      areas: AREAS.filter((area) => parts.some((part) => part.areas.includes(area))),
      ...(parts.some((part) => part.envelope) ? { envelope } : {}),
    });
  }
  if (today.readyLine !== undefined) bind("/readyLine", { areas: ["github", "details"] });
  if (today.unread) bind("/unread", ledger);
  return out;
}

export function readEnvelope(
  source: string,
  records: readonly ReadRecord[],
  intervalOf: number | ((record: ReadRecord) => number),
  now: Date,
): Envelope {
  const groups = new Map<number, ReadRecord[]>();
  for (const record of records) {
    const interval = typeof intervalOf === "number" ? intervalOf : intervalOf(record);
    const group = groups.get(interval) ?? [];
    group.push(record);
    groups.set(interval, group);
  }
  const severity = { unread: 0, fresh: 1, stale: 2, incomplete: 3, failed: 4 };
  const envelope = envelopeOf(records, { intervalMs: 0, now: now.getTime() });
  let state: typeof envelope.state = "unread";
  for (const [intervalMs, group] of groups) {
    const candidate = envelopeOf(group, { intervalMs, now: now.getTime() }).state;
    if (severity[candidate] > severity[state]) state = candidate;
  }
  if (state === "unread") return { source, state: "unread" };
  return {
    source,
    state,
    ...(envelope.observedAt === undefined ? {} : { observedAt: envelope.observedAt }),
    completeness: envelope.completeness,
    inferred: envelope.inferred,
  };
}

/** One envelope per area, each judged against its own sweep interval; no area is omitted. */
export function areaEnvelopes(
  reads: Partial<Record<AreaName, readonly ReadRecord[]>>,
  intervalOf: (area: AreaName, record: ReadRecord) => number,
  now: Date,
): AreaEnvelope[] {
  return AREAS.map((area) => ({
    area,
    envelope: readEnvelope(area, reads[area] ?? [], (record) => intervalOf(area, record), now),
  }));
}
