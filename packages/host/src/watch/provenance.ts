// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type {
  ActionItem as ActionItemWire,
  AreaEnvelope,
  Envelope,
  ValueSource,
} from "@spi-code/contracts";
import {
  type ActionItem,
  AREAS,
  type AreaName,
  type Briefing,
  envelopeOf,
  type ForkEntry,
  type LineModel,
  type LinePr,
  type Model,
  prVerdict,
  type QueueItem,
  RELEASES_EVERY_MS,
  type ReadRecord,
  type StackModel,
  sourceOf,
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
      return ordered(/^(halted: |PR #|gate 1 · )/.test(text) ? GITHUB : GITHUB_RUNS);
    case "cascade":
      // Conflict issues and stop labels (github); otherwise also a running cascade (runs).
      return ordered(state === "stopped" ? GITHUB : GITHUB_RUNS);
    case "main":
      // The cascade PR (github); otherwise also the proving main run and its jobs (runs).
      return ordered(text.startsWith("gate 2 · ") ? GITHUB : GITHUB_RUNS);
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

/** The section and each line bind the release ledger and fleet, even when no lines exist. */
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
    { path: "/releases", areas: ["fleet"], envelope },
  ];
}

function readEnvelope(
  source: string,
  records: readonly ReadRecord[],
  intervalMs: number,
  now: Date,
): Envelope {
  const envelope = envelopeOf(records, { intervalMs, now: now.getTime() });
  if (envelope.state === "unread") return { source, state: "unread" };
  return {
    source,
    state: envelope.state,
    ...(envelope.observedAt === undefined ? {} : { observedAt: envelope.observedAt }),
    completeness: envelope.completeness,
    inferred: envelope.inferred,
  };
}

/** One envelope per area, each judged against its own sweep interval; no area is omitted. */
export function areaEnvelopes(
  reads: Partial<Record<AreaName, readonly ReadRecord[]>>,
  intervalOf: (area: AreaName) => number,
  now: Date,
): AreaEnvelope[] {
  return AREAS.map((area) => ({
    area,
    envelope: readEnvelope(area, reads[area] ?? [], intervalOf(area), now),
  }));
}

type Areas = readonly AreaName[];

/** The pull request, its job details (failure classes, judgements) and nothing else. */
const PR_DETAILS = ["github", "details"] as const satisfies Areas;
/** A lane failure: the PR (github), its classified jobs (details) and the stack's attempts. */
const LANE = ["github", "lifecycle", "details"] as const satisfies Areas;

/**
 * The reads behind each value buildQueue put on an item, by the branch that computed it.
 * exists names what made the item and fixes its kind's constant sentences; class, text, url
 * and next name the branch that wrote them. A fact or effect returns undefined when core gave
 * it a label this file does not know, and the value it feeds stays unbound.
 */
interface Producers {
  readonly exists: Areas;
  readonly class: Areas;
  readonly text: Areas;
  readonly url: Areas;
  readonly next: Areas;
  fact(label: string): Areas | undefined;
  effect(index: number): Areas | undefined;
}

function uniform(areas: Areas, facts: Partial<Record<string, Areas>> = {}): Producers {
  return {
    exists: areas,
    class: areas,
    text: areas,
    url: areas,
    next: areas,
    fact: (label) => facts[label] ?? areas,
    effect: () => areas,
  };
}

function known(facts: Partial<Record<string, Areas>>): (label: string) => Areas | undefined {
  return (label) => facts[label];
}

/** prFacts: the PR and its review (github) and the first failure core classified (details). */
const PR_FACTS = {
  PR: GITHUB,
  head: GITHUB,
  review: GITHUB,
  check: PR_DETAILS,
  reason: PR_DETAILS,
} as const satisfies Record<string, Areas>;

function lineOf(model: Model, item: QueueItem): LineModel | undefined {
  return model.lines.find((line) => line.fork.id === item.scope);
}

/**
 * A gate's text, class and next follow prVerdict: a red PR is said through its classified
 * failures (github, details), a waiting one through the PR alone.
 */
function gateProducers(pr: LinePr | undefined, facts: Partial<Record<string, Areas>>): Producers {
  const red = pr !== undefined && prVerdict(pr.pr) === "red";
  const said = red ? PR_DETAILS : GITHUB;
  return {
    exists: GITHUB,
    class: said,
    text: said,
    url: GITHUB,
    next: said,
    fact: known({ ...PR_FACTS, ...facts }),
    effect: () => undefined,
  };
}

function producersOf(item: QueueItem, model: Model): Producers | undefined {
  const line = lineOf(model, item);
  switch (item.kind) {
    case "stack": {
      // Attempts and the maintenance state are lifecycle runs; the effects after the attempts
      // are ENV lane failures folded in from the PRs (github, details) since the first stop.
      const attempts = Math.max(model.stack.attempts.length - 1, 0);
      return {
        ...uniform(LIFECYCLE),
        fact: known({ state: LIFECYCLE, first: LIFECYCLE, last: LIFECYCLE, versions: STACK }),
        effect: (i) => (i < attempts ? LIFECYCLE : LANE),
      };
    }
    case "maintenance":
      return { ...uniform(LIFECYCLE), fact: known({ "set by": LIFECYCLE }) };
    case "lanes":
      return {
        ...uniform(LANE),
        fact: known({ environment: LIFECYCLE, "first failure": LANE }),
      };
    case "halt": {
      // The sync-failed issue says the halt; the failed runs since it and the lag are their own reads.
      const failed = line?.syncFailedSince ? 1 : 0;
      return {
        ...uniform(GITHUB),
        fact: known({
          issue: GITHUB,
          halt: GITHUB,
          entry: GITHUB,
          entries: GITHUB,
          filter: GITHUB,
          held: ["upstream"],
        }),
        effect: (i) => (i < failed ? GITHUB_RUNS : ["upstream"]),
      };
    }
    case "sync-run":
      // A completed failed run (runs) on a read repository with no sync PR open (github).
      return {
        ...uniform(GITHUB_RUNS),
        url: ["runs"],
        fact: known({ run: ["runs"] }),
        effect: () => undefined,
      };
    case "conflict":
      return { ...uniform(GITHUB), fact: known({ issue: GITHUB }), effect: () => undefined };
    case "cascade":
      return { ...uniform(GITHUB), fact: known({ tracking: GITHUB }), effect: () => undefined };
    case "labels":
      return { ...uniform(GITHUB), fact: known({ issue: GITHUB }), effect: () => undefined };
    case "main":
      return {
        ...uniform(["runs"]),
        fact: known({ run: ["runs"], job: ["runs"], reason: ["runs"] }),
        effect: () => undefined,
      };
    case "template-run":
      return { ...uniform(["runs"]), fact: known({ run: ["runs"] }), effect: () => undefined };
    case "gate1":
      return gateProducers(line?.syncPr, { held: ["upstream"] });
    case "gate2":
      return gateProducers(line?.cascadePr, { merge: GITHUB });
    case "access":
      return { ...uniform(PR_DETAILS), fact: known(PR_FACTS), effect: () => undefined };
    case "release-red":
      return { ...uniform(PR_DETAILS), fact: known(PR_FACTS), effect: () => undefined };
    case "template-red":
      // "moves to" names the fork's template marker (github) and its compare target (template).
      return {
        ...uniform(PR_DETAILS),
        fact: known({ ...PR_FACTS, "moves to": ["github", "template"] }),
        effect: () => undefined,
      };
    case "releases":
      // One fact per release PR, labelled by repository: each reads the PR and its checks.
      return uniform(PR_DETAILS);
    case "template-pr":
      return {
        exists: GITHUB,
        class: PR_DETAILS,
        text: PR_DETAILS,
        url: GITHUB,
        next: PR_DETAILS,
        fact: known(PR_FACTS),
        effect: () => GITHUB,
      };
    case "template-set":
      // The text weighs ENV failures (details) against the stack (lifecycle), the reviews
      // (github) and the template's head and latest tag against the targets (template).
      return {
        exists: GITHUB,
        class: GITHUB,
        text: ["github", "lifecycle", "details", "template"],
        url: GITHUB,
        next: GITHUB,
        fact: known({
          target: ["github", "template"],
          PRs: GITHUB,
          latest: ["github", "template"],
          review: GITHUB,
          failing: PR_DETAILS,
        }),
        effect: () => PR_DETAILS,
      };
    case "rollout":
      // readItem says a rollout through rolloutWords over the whole rollout model.
      return uniform(LINES);
    case "approvals":
      return uniform(["approvals"]);
    case "bump":
      return {
        ...uniform(GITHUB),
        text: STACK,
        fact: known({ PR: GITHUB, declared: GITHUB }),
        effect: () => undefined,
      };
    case "radar": {
      // radarState reaches will-halt or toolchain-queued only past a halt issue and a sync PR
      // failing on the toolchain (github, details); the rest is the radar's prediction.
      const state = ["github", "radar", "details"] as const satisfies Areas;
      return {
        exists: state,
        class: state,
        text: state,
        url: ["radar"],
        next: state,
        fact: known({
          commit: ["radar"],
          map: ["radar"],
          value: ["radar"],
          filter: ["radar"],
          queued: ["radar"],
        }),
        effect: () => ["radar"],
      };
    }
    case "port":
      return {
        ...uniform(["radar"]),
        fact: known({ seeded: ["fleet"], tree: ["radar"], owed: ["radar"], match: ["radar"] }),
      };
    case "security":
      // An alert group's Dependabot PR is matched from the repository's PRs (github).
      return {
        ...uniform(ALERTS),
        next: REPO,
        fact: known({
          why: ALERTS,
          package: ALERTS,
          rule: ALERTS,
          where: ALERTS,
          fix: ALERTS,
          PR: REPO,
        }),
      };
    default:
      return undefined;
  }
}

function union(...parts: (Areas | undefined)[]): AreaName[] | undefined {
  if (parts.some((part) => part === undefined)) return undefined;
  return ordered(parts.flatMap((part) => part ?? []));
}

function fact(item: QueueItem, label: string): string | undefined {
  return item.cause.find((f) => f.label === label)?.value;
}

/** causeOf, branch by branch: the cause names only what the branch it took read. */
function causeAreas(item: QueueItem, p: Producers): AreaName[] | undefined {
  if (item.kind === "halt") return union(p.exists, p.fact("halt"));
  if (item.kind === "radar") {
    if (item.cls !== "TOOLCHAIN" || item.effects.length === 0) return union(p.class);
    return union(p.class, ...item.effects.map((_, i) => p.effect(i)));
  }
  if (item.cls === "TOOLCHAIN") {
    const reason = fact(item, "reason") ?? "";
    const java = /allowed range \[(\d+)/.test(reason)
      ? p.fact("reason")
      : /^Java (\d+)$/.test(fact(item, "value") ?? "")
        ? p.fact("value")
        : /requires Java (\d+)/.test(item.text)
          ? p.text
          : null;
    if (java !== null) {
      return union(p.class, java, /JDK (\d+)/.test(reason) ? p.fact("reason") : []);
    }
  }
  if (item.cls === "PORT") {
    return union(p.class, fact(item, "tree") === undefined ? p.exists : p.fact("tree"));
  }
  const said =
    fact(item, "reason") !== undefined
      ? "reason"
      : fact(item, "why") !== undefined
        ? "why"
        : undefined;
  return union(p.class, said ? p.fact(said) : p.text);
}

/** effectOf: the first three effects, else the held fact, else the item's fixed sentence. */
function effectAreas(item: QueueItem, p: Producers): AreaName[] | undefined {
  // A radar item's effect looks for a stuck incident on the same move across the queue.
  if (item.kind === "radar") return ordered(MODEL);
  const shown = item.kind === "approvals" ? item.effects : item.effects.slice(0, 3);
  if (shown.length > 0) return union(...shown.map((_, i) => p.effect(i)));
  if (fact(item, "held") !== undefined) return union(p.fact("held"));
  return union(p.exists);
}

/**
 * whySection lists the cause facts the cause and effect sentences did not already say, then
 * the item's source link. The filter compares text the item already holds and reads nothing.
 */
function whyAreas(item: QueueItem, p: Producers, said: string): AreaName[] | undefined {
  const facts = item.cause.filter(
    (f) => f.label !== "held" && !said.includes(f.value.toLowerCase()),
  );
  const parts: (Areas | undefined)[] = facts.map((f) => p.fact(f.label));
  if (sourceOf(item)) parts.push(p.url);
  if (parts.length === 0) return undefined;
  return union(...parts);
}

const ENTRY_ORDER = ["listed", "unlisted", "unread"] as const;

/**
 * sameEntry's rows in core's order, each with the fork reads behind it: one row per listed,
 * unlisted or unread entry, then one summary row for every fork with no such entry.
 */
function entryRows(entries: readonly ForkEntry[]): ForkEntry[][] {
  const rows: ForkEntry[][] = ENTRY_ORDER.flatMap((state) =>
    entries.filter((entry) => entry.state === state).map((entry) => [entry]),
  );
  const absent = entries.filter((entry) => entry.state === "absent");
  if (absent.length > 0) rows.push(absent);
  return rows;
}

function filtersEnvelope(entries: readonly ForkEntry[], now: Date): Envelope {
  return readEnvelope(
    "filters",
    entries.flatMap((entry) => entry.reads),
    0,
    now,
  );
}

/**
 * A label core computed from reads, chosen by the branch core took. The dispatch labels are
 * fixed text and bind nothing. laneActions offers "Re-run when deployable" on the stack's
 * deployability alone; when deployable, "Re-run lanes · N" also counts the lanes the lane load
 * (github, runs) leaves room for and their judged checks.
 */
function labelAreas(verb: string, deployable: boolean): readonly AreaName[] | undefined {
  switch (verb) {
    case "approve-runs":
      return ["approvals"];
    case "rerun":
      return deployable ? ["github", "runs", "lifecycle", "details"] : LIFECYCLE;
    case "sync-template":
    case "roll-out":
      return LINES;
    case "dispatch-env-refresh":
    case "dispatch-env-upgrade":
      return undefined;
    default:
      return MODEL;
  }
}

/**
 * A reason core derived from reads, by the branch that set it. A write block is host and
 * sweep-marker state and never reaches here. A re-run's stop judgement (laneActions) outranks
 * the rest; past it, a deployable stack leaves only the lane load, and a held one leaves host
 * state (no durable ops, a wait already held), which binds nothing.
 */
function reasonAreas(
  verb: string,
  item: QueueItem,
  deployable: boolean,
): readonly AreaName[] | undefined {
  switch (verb) {
    case "dispatch-env-refresh":
    case "dispatch-env-upgrade":
      // The only other reason is a lifecycle run already queued or running.
      return LIFECYCLE;
    case "rerun":
      if (item.judgement?.response === "stop") return ["github", "details"];
      return deployable ? GITHUB_RUNS : undefined;
    case "sync-template":
    case "roll-out":
      return LINES;
    case "approve-runs":
      return undefined;
    default:
      return MODEL;
  }
}

export interface InspectSources {
  readonly model: Model;
  readonly item: QueueItem;
  /** The inspection's cause and effect sentences, which whySection checks facts against. */
  readonly cause: string;
  readonly effect: string;
  /** Rows in the result's related list, in the order the route writes them. */
  readonly related: {
    readonly themes: number;
    readonly evidence: number;
    readonly sameEntry: number;
  };
  readonly approval: boolean;
  /** Core's actions and the contract actions mapped from them, one to one and in order. */
  readonly actions: readonly ActionItem[];
  readonly drawn: readonly Pick<ActionItemWire, "label" | "eligibilityReason">[];
  /** core's writeBlocked for this request. */
  readonly blocked: string | undefined;
  /** Whether the stack read deployable, the branch laneActions takes. */
  readonly deployable: boolean;
  /** The FILTERS read across forks, when the item is a checkable halt. */
  readonly entries: readonly ForkEntry[] | undefined;
  readonly now: Date;
}

/**
 * Provenance for an inspect result, keyed by RFC 6901 pointer into it. Each value binds the
 * reads of the branch that computed it, never every read its item touched. Values from the
 * inspector's on-demand reads bind fleet with an envelope judged at the request from the
 * reads behind that value alone: those reads have no sweep interval and were observed for
 * this request.
 */
export function inspectProvenance(sources: InspectSources): ValueSource[] {
  const { item, related, entries, now } = sources;
  const out: ValueSource[] = [];
  const add = (path: string, areas: Areas | undefined, envelope?: Envelope): void => {
    if (!areas || areas.length === 0) return;
    out.push({ path, areas: ordered(areas), ...(envelope ? { envelope } : {}) });
  };
  const p = producersOf(item, sources.model);
  if (p) {
    add("/class", p.class);
    add("/cause", causeAreas(item, p));
    add("/effect", effectAreas(item, p));
    const listed = entries?.filter((entry) => entry.state === "listed") ?? [];
    if (listed.length > 0) add("/next", union(p.next, ["fleet"]), filtersEnvelope(listed, now));
    else add("/next", p.next);
    add("/why", whyAreas(item, p, `${sources.cause} ${sources.effect}`.toLowerCase()));
  }
  let row = 0;
  // A theme row's fork, state and inspect link are found across every theme and the queue.
  for (let i = 0; i < related.themes; i++) add(`/related/${row++}`, MODEL);
  for (let i = 0; i < related.evidence; i++) add(`/related/${row++}`, p?.url);
  const rows = entries ? entryRows(entries) : [];
  if (rows.length === related.sameEntry) {
    for (const reads of rows) add(`/related/${row++}`, ["fleet"], filtersEnvelope(reads, now));
  }
  if (sources.approval) add("/approval/reason", ["approvals"]);
  sources.actions.forEach((action, i) => {
    const verb = typeof action.binding?.verb === "string" ? action.binding.verb : "";
    const label = labelAreas(verb, sources.deployable);
    if (label && sources.drawn[i]?.label === action.label) add(`/actions/${i}/label`, label);
    const reason = action.reason;
    if (reason === undefined || reason === sources.blocked) return;
    if (sources.drawn[i]?.eligibilityReason !== reason) return;
    const areas = reasonAreas(verb, item, sources.deployable);
    if (areas) add(`/actions/${i}/eligibilityReason`, areas);
  });
  return out;
}
