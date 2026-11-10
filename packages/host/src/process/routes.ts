// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { DatabaseSync } from "node:sqlite";
import {
  type AreaEnvelope,
  type Briefing,
  type InspectResult,
  InspectResultSchema,
  type LastSweep,
  type Message,
  PROTOCOL_VERSION,
  type ReadRecord,
  ReadRecordSchema,
  type SweepProgress,
  type SweepStatus,
  SweepStatusSchema,
  type ViewSnapshot,
  ViewSnapshotSchema,
  WebUrlSchema,
} from "@spi-code/contracts";
import {
  approvalSection,
  buildModel,
  type CoreContext,
  type ReadRecord as CoreReadRecord,
  cacheSchema,
  checkable,
  createSweeper,
  type Exec,
  emptyFacts,
  entryAcrossForks,
  type Facts,
  Gh,
  Glab,
  type InspectOptions,
  inspectItem,
  inspectRepo,
  inspectStep,
  inspectTitle,
  inspectUpstreamFork,
  inspectUpstreamPlan,
  isMonth,
  itemClass,
  type Model,
  type MrInspection,
  monthFacts,
  mrBoard,
  mrTitle,
  NOTES_LABEL,
  type QueueItem,
  RELEASE_PREFIX,
  REPO_PREFIX,
  type ReleaseDoc,
  type RepoInspection,
  type RunFact,
  releaseDoc,
  STEP_PREFIX,
  stepTitle,
  UPSTREAM_ITEM,
  UPSTREAM_PREFIX,
  type UpstreamBoard,
  verbsOf,
} from "@spi-code/core";
import { z } from "zod";
import { createSeenStore } from "../store/seen.js";
import { createSnapshotStore, type SnapshotRecord } from "../store/snapshots.js";
import { emptySweepStatus, SWEEP_SCHEDULE, type SweepSchedulerStatus } from "../sweep/status.js";
import { appActions, readNotes } from "../watch/project.js";
import { type RunHit, recordedRuns } from "../watch/recorded-runs.js";
import { baselineItems, parseSeenItems, type SeenBaseline, seenSince } from "../watch/seen.js";
import type { HostRoutes, HostSend } from "./port.js";

export interface WatchRoutesOptions {
  /** Opens the migrated WAL store on first use; the routes never close it. */
  readonly db: () => DatabaseSync;
  readonly fleet: string;
  readonly ctx: CoreContext;
  readonly appData: string;
  /** Runs the inspector's on-demand reads. */
  readonly exec: Exec;
  readonly inspect?: InspectOptions;
  readonly onError: (error: unknown) => void;
  readonly requestSweep?: (request: { now?: true | undefined }) => Promise<boolean>;
  readonly sweepProgress?: () => SweepProgress | undefined;
}

/** The snapshot key a SweepService writes for this context's fleet. */
export function watchFleet(ctx: CoreContext): string {
  return ctx.stackRepo;
}

const persistedSchema = z.object({
  facts: z.custom<Facts>((value) => typeof value === "object" && value !== null),
  cache: z
    .object({
      budget: cacheSchema.shape.budget.extend({ floor: z.unknown().optional() }),
      releases: z.unknown().optional(),
    })
    .optional(),
});

const SweepBudgetSchema = SweepStatusSchema.omit({
  nextSweepAt: true,
  forceCooldownUntil: true,
  schedule: true,
  lastSweep: true,
});
type SweepBudget = z.infer<typeof SweepBudgetSchema>;

interface Persisted {
  view: ViewSnapshot;
  status: SweepBudget;
  facts: Facts | undefined;
  releases: unknown;
}

function persisted(record: SnapshotRecord): Persisted {
  const envelope = record.envelope;
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    throw new TypeError("Invalid stored Watch envelope");
  }
  const view = ViewSnapshotSchema.parse({ ...envelope, cursor: record.cursor });
  const state = persistedSchema.safeParse(record.facts);
  const budget = state.success ? state.data.cache?.budget : undefined;
  const floor = SweepBudgetSchema.shape.floor.safeParse(budget?.floor);
  const status = SweepBudgetSchema.parse({
    remaining: budget?.remaining == null ? null : Math.floor(budget.remaining),
    ...(floor.success && floor.data !== undefined ? { floor: floor.data } : {}),
    resetAt: budget?.resetAt ?? null,
    deferredAreas: (budget?.deferred ?? []).map(({ area, reason }) => ({ area, reason })),
  });
  return {
    view,
    status,
    facts: state.success ? { ...emptyFacts(), ...state.data.facts } : undefined,
    releases: state.success ? state.data.cache?.releases : undefined,
  };
}

function readRecord(record: CoreReadRecord): ReadRecord {
  const { failure, retainedFrom, inferred, ...rest } = record;
  return ReadRecordSchema.parse({
    ...rest,
    ...(failure === undefined ? {} : { failure }),
    ...(retainedFrom === undefined ? {} : { retainedFrom }),
    ...(inferred === undefined ? {} : { inferred }),
  });
}

function webUrl(url: string | undefined): { url: string } | Record<string, never> {
  return url !== undefined && WebUrlSchema.safeParse(url).success ? { url } : {};
}

/**
 * Core inspection mapped to the contract, with the FILTERS read for a checkable halt. Areas are
 * the sweep's stored envelopes. Provenance is empty: no value is bound to a source until core
 * records which reads produced it, so the window shows none as inferred.
 */
export async function inspectResult(
  model: Model,
  item: QueueItem,
  now: Date,
  ctx: CoreContext,
  exec: Exec,
  areas: readonly AreaEnvelope[],
  opts: InspectOptions = {},
): Promise<InspectResult> {
  const entries = checkable(item.halt)
    ? await entryAcrossForks(new Gh(exec), new Glab(exec), item.halt, ctx)
    : undefined;
  const inspection = inspectItem(
    model,
    item,
    now,
    ctx,
    entries ? { others: { id: item.id, entries } } : {},
  );
  const approvals = approvalSection(item, model, opts);
  const evidence = new Map<string, ReadRecord>();
  for (const record of (entries ?? []).flatMap((entry) => entry.attempted)) {
    const parsed = readRecord(record);
    evidence.set(JSON.stringify(parsed), parsed);
  }
  return InspectResultSchema.parse({
    id: item.id,
    title: inspectTitle(item),
    class: inspection.class,
    cause: inspection.cause,
    effect: inspection.effect,
    next: inspection.next,
    why: inspection.why.map((field) => `${field.label}: ${field.value}`).join("; "),
    evidence: [...evidence.values()],
    related: [
      ...inspection.related.map((r) => ({
        text: r.text,
        state: r.state,
        ...(r.inspect ? { inspect: r.inspect } : webUrl(r.url)),
      })),
      ...inspection.evidence.map((field) => ({
        text: field.value,
        state: field.label,
        ...webUrl(field.href),
      })),
      ...(inspection.sameEntry?.rows ?? []).map((row) => ({
        text: row.trailing ? `${row.text} · ${row.trailing}` : row.text,
        state: row.chip?.label ?? "",
        ...webUrl(row.href),
      })),
    ],
    approval: approvals ? { id: item.id, state: "pending", reason: approvals.title } : null,
    actions: appActions([
      ...verbsOf(item, model, ctx, opts),
      ...(approvals?.items.flatMap((entry) => entry.actions) ?? []),
    ]),
    areas,
    provenance: [],
  });
}

function stepResult(
  model: Model,
  id: string,
  ctx: CoreContext,
  areas: readonly AreaEnvelope[],
): InspectResult {
  const step = inspectStep(model, id, ctx);
  return InspectResultSchema.parse({
    id,
    title: stepTitle(model, id),
    class: "ROLLOUT",
    cause: step.summary,
    effect: step.chip ?? "",
    next: "",
    why: step.status.label,
    evidence: [],
    related: [
      ...step.changes.map((change) => ({
        text: change.text,
        state: change.trailing,
        ...webUrl(change.href),
      })),
      ...step.forks.map((fork) => ({ text: fork.text, state: fork.trailing })),
      ...step.evidence.map((entry) => ({
        text: entry.text,
        state: "Evidence",
        ...webUrl(entry.href),
      })),
    ],
    approval: null,
    actions: [],
    areas,
    provenance: [],
  });
}

function mrResult(
  board: MrInspection,
  id: string,
  title: string | undefined,
  areas: readonly AreaEnvelope[],
): InspectResult {
  return InspectResultSchema.parse({
    id,
    title,
    class:
      board.header.status.label === "HALT"
        ? "HALT"
        : board.header.status.label === "TOOLCHAIN"
          ? "TOOLCHAIN"
          : "READY",
    cause: board.sections[0]?.items[0]?.text ?? "",
    effect: board.header.chip ?? "",
    next: "",
    why: board.header.status.label,
    evidence: [],
    related: board.sections.flatMap((section) =>
      section.items.map((row) => ({
        text: [row.text, row.detail].filter(Boolean).join(": "),
        state: [section.title, row.trailing].filter(Boolean).join(" · "),
        ...webUrl(row.href),
      })),
    ),
    approval: null,
    actions: [],
    areas,
    provenance: [],
  });
}

function releaseResult(doc: ReleaseDoc, areas: readonly AreaEnvelope[]): InspectResult {
  const actionText = (action: ReleaseDoc["required"][number]) =>
    [
      action.title,
      action.body,
      action.owner ? `Owner: ${action.owner}` : undefined,
      action.when ? `When: ${action.when}` : undefined,
      action.ifSkipped ? `If skipped: ${action.ifSkipped}` : undefined,
    ]
      .filter(Boolean)
      .join("; ");
  return InspectResultSchema.parse({
    id: doc.id,
    title: doc.name,
    class: doc.unread.length > 0 ? "UNREAD" : "READY",
    cause: doc.headline,
    effect: doc.stateText,
    next: doc.required.map(actionText).join("\n"),
    why: [
      NOTES_LABEL[doc.notes],
      doc.notesError,
      ...doc.stats.map((stat) => `${stat.figure} ${stat.label}`),
      ...(doc.unread.length > 0 ? [`Unread: ${doc.unread.join(", ")}`] : []),
    ]
      .filter(Boolean)
      .join("; "),
    evidence: [],
    related: [
      ...doc.keyChanges.map((text) => ({ text, state: "Key change" })),
      ...doc.highlights.map((entry) => ({
        text: [entry.title, entry.body].filter(Boolean).join(": "),
        state: "Highlight",
      })),
      ...doc.changelog.flatMap((area) =>
        area.items.map((entry) => ({ text: entry.text, state: `${area.area}: ${entry.type}` })),
      ),
      ...doc.issues.map((issue) => ({
        text: [issue.title, issue.body].filter(Boolean).join(": "),
        state: issue.state,
      })),
      ...doc.rows.map((row) => ({
        text: `${row.id}: ${row.version}`,
        state: row.state,
        ...webUrl(row.url),
      })),
      ...doc.info.map((action) => ({ text: actionText(action), state: "Info" })),
      ...doc.links.map((link) => ({
        text: link.label,
        state: "Releases",
        ...webUrl(link.url),
      })),
    ],
    approval: null,
    actions: [],
    areas,
    provenance: [],
  });
}

/** A repository's tabs flatten into related rows, each stating its tab, section and marks. */
function repoResult(
  id: string,
  repo: RepoInspection,
  areas: readonly AreaEnvelope[],
): InspectResult {
  return InspectResultSchema.parse({
    id,
    title: repo.title,
    class: "SECURITY",
    cause: repo.title,
    effect: repo.chip,
    next: "",
    why: `${repo.status.label}; ${repo.summary}`,
    evidence: [],
    related: [
      ...repo.tabs.flatMap((tab) =>
        tab.sections.flatMap((section) =>
          section.items.map((item) => ({
            text: item.detail ? `${item.text} · ${item.detail}` : item.text,
            state: [tab.label, section.title, item.chip?.label, item.trailing]
              .filter(Boolean)
              .join(" · "),
            ...webUrl(item.href),
          })),
        ),
      ),
      ...repo.links.map((link) => ({ text: link.text, state: "On GitHub", ...webUrl(link.href) })),
    ],
    approval: null,
    actions: [],
    areas,
    provenance: [],
  });
}

/** The board's untitled lead rows, whose first line becomes Effect and so stays out of Related. */
function untitledLead(board: UpstreamBoard) {
  const lead = board.sections[0];
  return lead?.kind === "rows" && lead.title === undefined ? lead : undefined;
}

export function upstreamPlanResult(
  board: UpstreamBoard,
  areas: readonly AreaEnvelope[],
): InspectResult {
  const rows = board.sections[0];
  const next = board.sections.find((section) => section.kind === "cards")?.items[0];
  const lead = untitledLead(board);
  return InspectResultSchema.parse({
    id: UPSTREAM_ITEM,
    title: board.title,
    class: board.header.status.tone === "error" ? "TOOLCHAIN" : "ROLLOUT",
    cause: rows?.kind === "rows" ? (rows.items[1]?.text ?? board.title) : board.title,
    effect: rows?.kind === "rows" ? (rows.items[0]?.text ?? "") : "",
    next: next?.title ?? "",
    why: board.header.status.label,
    evidence: [],
    related: board.sections.flatMap((section): InspectResult["related"] => {
      if (section === lead) return [];
      const state = section.title ?? "";
      switch (section.kind) {
        case "rows":
          return section.items.map((row) => ({
            text: [row.chip?.label, row.text, row.trailing].filter(Boolean).join(" · "),
            state,
            ...(row.action ? { inspect: row.action.payload.id } : webUrl(row.href)),
          }));
        case "cards":
          return section.items.flatMap((card) =>
            card.fields.map((field) => ({
              text: field.value,
              state,
              ...webUrl(field.href),
            })),
          );
        case "bars":
          return section.items.map((bar) => ({
            text: `${bar.label}: ${bar.trailing}`,
            state,
          }));
        case "table":
          return section.rows.map((row) => ({
            text: section.columns
              .map(({ key, label }) => {
                const cell = row[key];
                return `${label}: ${typeof cell === "string" ? cell : (cell?.value ?? cell?.badges?.map((badge) => badge.text).join(", ") ?? "")}`;
              })
              .join(" · "),
            state,
            ...webUrl(typeof row.fork === "object" ? row.fork.href : undefined),
          }));
      }
      throw new TypeError("Unsupported upstream inspector section");
    }),
    approval: null,
    actions: appActions(
      board.sections.flatMap((s) =>
        s.kind === "cards" ? s.items.flatMap((card) => card.actions ?? []) : [],
      ),
    ),
    areas,
    provenance: [],
  });
}

export function upstreamForkResult(
  id: string,
  board: UpstreamBoard,
  areas: readonly AreaEnvelope[],
): InspectResult {
  const { label, tone } = board.header.status;
  const lead = untitledLead(board);
  return InspectResultSchema.parse({
    ...upstreamPlanResult(board, areas),
    id,
    class:
      label === "SYNC HALTS"
        ? "HALT"
        : label === "UNREAD"
          ? "UNREAD"
          : tone === "error"
            ? "TOOLCHAIN"
            : tone === "ok"
              ? "READY"
              : "ROLLOUT",
    cause: board.title,
    effect: lead ? (lead.items[0]?.text ?? "") : board.header.chip,
  });
}

const SERVICE_PREFIX = "service:";
const RUN_PREFIX = "run:";
const HOLD_PREFIX = "hold:";
const THEME_PREFIX = "theme:";
const STATION_PREFIX = "station:";
const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

type Theme = Briefing["themes"][number];
type EnvEvent = Briefing["environment"]["lanes"][number]["events"][number];

/**
 * A workflow run the sweep read, wherever it was read: a fork lane, the stack, or an approval.
 * The id is matched as text, so only the exact spelling the views hand over resolves.
 */
function findRun(facts: Facts, key: string, stackRepo: string): RunHit | undefined {
  return recordedRuns(facts, stackRepo).find(({ run }) => String(run.id) === key);
}

/** The queue item that folds this run, as the Environment lanes and lane runs name it. */
function coveringItem(model: Model, run: RunFact): QueueItem | undefined {
  const stack = model.queue.items.find((item) => item.kind === "stack");
  if (stack && model.stack.attempts.some((a) => a.run.id === run.id)) return stack;
  return model.queue.items.find(
    (item) =>
      item.lanes?.some((lane) => lane.runId === run.id) ||
      item.url === run.url ||
      item.url?.startsWith(`${run.url}/`),
  );
}

function runResult(
  id: string,
  { run, repo, workflow }: RunHit,
  item: QueueItem | undefined,
  areas: readonly AreaEnvelope[],
): InspectResult {
  const outcome = run.status === "completed" ? (run.conclusion ?? "completed") : run.status;
  return InspectResultSchema.parse({
    id,
    title: `${run.name} #${run.id}`,
    class: item ? itemClass(item) : FAILED.has(run.conclusion ?? "") ? "INCIDENT" : "READY",
    cause: `${run.name} #${run.id} on ${repo}`,
    effect: `${workflow} run ${outcome}`,
    next: item ? item.text : "",
    why: [
      run.event,
      run.branch ? `on ${run.branch}` : undefined,
      run.sha ? `at ${run.sha.slice(0, 7)}` : undefined,
      `attempt ${run.attempt}`,
    ]
      .filter(Boolean)
      .join(" "),
    evidence: [],
    related: [
      { text: run.title || run.name, state: "On GitHub", ...webUrl(run.url) },
      ...(item ? [{ text: item.text, state: "In the queue", inspect: item.id }] : []),
    ],
    approval: null,
    actions: [],
    areas,
    provenance: [],
  });
}

/** A maintenance hold the Environment's Held lane draws, with the runs it overlaps. */
function holdResult(
  id: string,
  hold: EnvEvent,
  briefing: Briefing,
  areas: readonly AreaEnvelope[],
): InspectResult {
  const from = Date.parse(hold.start);
  const to = hold.end === undefined ? Number.POSITIVE_INFINITY : Date.parse(hold.end);
  const runs = briefing.environment.lanes
    .filter((lane) => lane.id !== "holds")
    .flatMap((lane) =>
      lane.events
        .filter((e) => {
          const start = Date.parse(e.start);
          const end = e.end === undefined ? Number.POSITIVE_INFINITY : Date.parse(e.end);
          return start <= to && end >= from;
        })
        .map((e) => ({
          text: `${lane.label} ${e.label}`,
          state: e.detail,
          inspect: e.inspect ?? `${RUN_PREFIX}${e.id}`,
        })),
    );
  return InspectResultSchema.parse({
    id,
    title: `Held ${hold.label}`,
    class: hold.end === undefined ? "GATE" : "READY",
    cause: `Held ${hold.label}`,
    effect: hold.detail,
    next: "",
    why: `${hold.start} to ${hold.end ?? "now"}`,
    evidence: [],
    related: runs,
    approval: null,
    actions: [],
    areas,
    provenance: [],
  });
}

const THEME_CLASS: Readonly<Record<Theme["kind"], InspectResult["class"]>> = {
  halt: "HALT",
  toolchain: "TOOLCHAIN",
  port: "PORT",
  rollout: "ROLLOUT",
  deadline: "GATE",
};

/** A Horizon theme and its queue item, told from the persisted briefing. */
function themeResult(
  id: string,
  theme: Theme,
  areas: readonly AreaEnvelope[],
  item: Briefing["focus"][number] | undefined,
): InspectResult {
  const fork = (state: string) => (f: Theme["certain"][number]) => ({
    text: f.fork,
    state: `${state} · ${f.state}`,
    ...(f.inspect ? { inspect: f.inspect } : webUrl(f.url)),
  });
  return InspectResultSchema.parse({
    id,
    title: theme.title,
    class: THEME_CLASS[theme.kind],
    cause: theme.title,
    effect: theme.sub,
    next: theme.next,
    why: theme.when ?? "",
    evidence: [],
    related: [
      ...theme.certain.map(fork("certain")),
      ...theme.possible.map(fork("possible")),
      ...theme.exposed.map((name) => ({ text: name, state: "exposed" })),
      ...(item ? [{ text: item.title, state: item.cls, inspect: item.id }] : []),
    ],
    approval: null,
    actions: [],
    areas,
    provenance: [],
  });
}

type Line = Model["lines"][number];
type Related = InspectResult["related"][number];

const LINE_STATIONS = {
  upstream: { title: "Upstream", kinds: ["radar", "port"] },
  sync: { title: "Sync PR", kinds: ["halt", "sync-run", "gate1"] },
  cascade: { title: "Cascade", kinds: ["conflict", "cascade", "labels"] },
  main: { title: "Main", kinds: ["main", "gate2"] },
} as const satisfies Record<string, { title: string; kinds: readonly QueueItem["kind"][] }>;

function prRelated(pr: Line["syncPr"], state: string): Related[] {
  return pr ? [{ text: `#${pr.pr.number} ${pr.pr.title}`, state, ...webUrl(pr.pr.url) }] : [];
}

function runRelated(run: Line["mainRun"], state: string): Related[] {
  return run
    ? [
        {
          text: [run.name, run.status === "completed" ? run.conclusion : run.status, run.createdAt]
            .filter(Boolean)
            .join(" · "),
          state,
          ...webUrl(run.url),
        },
      ]
    : [];
}

/** The station's own facts: never another station's cause, so a clean Sync PR stays clean. */
function lineStationFacts(
  line: Line,
  id: keyof typeof LINE_STATIONS,
): { why: string[]; related: Related[] } {
  switch (id) {
    case "upstream":
      return {
        why: (line.upstream?.commits ?? []).slice(0, 3).map((c) => c.title),
        related: line.upstream?.head
          ? [
              {
                text: line.upstream.head.sha.slice(0, 7),
                state: "Upstream head",
                ...webUrl(line.upstream.head.url),
              },
            ]
          : [],
      };
    case "sync":
      return {
        why: [
          ...(line.halt ? [line.halt.detail] : []),
          ...(line.syncPr?.failures.map((f) => f.reason ?? f.check) ?? []),
        ],
        related: [
          ...(line.halt
            ? [
                {
                  text: `#${line.halt.issue.number} ${line.halt.issue.title}`,
                  state: "Halt issue",
                  ...webUrl(line.halt.issue.url),
                },
              ]
            : []),
          ...prRelated(line.syncPr, "Sync PR"),
          ...runRelated(line.syncRun, "Sync Upstream run"),
        ],
      };
    case "cascade":
      return {
        why: [
          ...line.conflicts.map((issue) => issue.title),
          ...line.cascadeLabels.filter(
            (label) => label.startsWith("cascade") || label.endsWith("-failed"),
          ),
        ],
        related: [
          ...line.conflicts.map((issue) => ({
            text: `#${issue.number} ${issue.title}`,
            state: "Conflict issue",
            ...webUrl(issue.url),
          })),
          ...(line.tracking
            ? [
                {
                  text: `#${line.tracking.number} ${line.tracking.title}`,
                  state: "Tracking issue",
                  ...webUrl(line.tracking.url),
                },
              ]
            : []),
        ],
      };
    case "main":
      return {
        why: [
          ...(line.cascadePr?.failures.map((f) => f.reason ?? f.check) ?? []),
          ...(line.mainRed && line.mainRed.cls !== "ENV"
            ? [`${line.mainRed.job?.name ?? "Validation"} failed on main`]
            : []),
        ],
        related: [
          ...prRelated(line.cascadePr, "Cascade PR"),
          ...runRelated(line.mainRed?.run ?? line.mainRun, "Main run"),
        ],
      };
  }
}

function lineStationResult(
  model: Model,
  line: Line,
  station: Line["stations"][number] & { id: keyof typeof LINE_STATIONS },
  id: string,
  now: Date,
  areas: readonly AreaEnvelope[],
): InspectResult {
  const fork = line.fork.id;
  const { title, kinds } = LINE_STATIONS[station.id];
  const items = model.queue.items.filter(
    (item) => item.scope === fork && (kinds as readonly string[]).includes(item.kind),
  );
  const facts = lineStationFacts(line, station.id);
  const upstream = inspectUpstreamFork(model, fork, now);
  return InspectResultSchema.parse({
    id,
    title: `${fork} · ${title}`,
    class:
      station.state === "unknown"
        ? "UNREAD"
        : items[0]
          ? itemClass(items[0])
          : station.state === "stopped"
            ? "INCIDENT"
            : station.state === "waiting"
              ? "GATE"
              : "READY",
    cause: station.text,
    effect: station.state,
    next: "",
    why: facts.why.join("; "),
    related: [
      ...items.map((item) => ({ text: item.text, state: title, inspect: item.id })),
      ...facts.related,
      ...(upstream
        ? [{ text: upstream.title, state: "Upstream", inspect: `${UPSTREAM_PREFIX}${fork}` }]
        : []),
    ],
    evidence: [],
    approval: null,
    actions: [],
    areas,
    provenance: [],
  });
}

function stationResult(
  model: Model,
  id: string,
  now: Date,
  areas: readonly AreaEnvelope[],
): InspectResult | undefined {
  for (const line of model.lines) {
    const station = line.stations.find((s) => `station:${line.fork.id}:${s.id}` === id);
    if (!station) continue;
    if (station.id in LINE_STATIONS)
      return lineStationResult(
        model,
        line,
        station as Line["stations"][number] & { id: keyof typeof LINE_STATIONS },
        id,
        now,
        areas,
      );
    if (station.id !== "release" && station.id !== "lane") return undefined;
    const release = station.id === "release";
    return InspectResultSchema.parse({
      id,
      title: `${line.fork.id} · ${release ? "Release" : "Stack lane"}`,
      class:
        station.state === "unknown"
          ? "UNREAD"
          : station.state === "stopped"
            ? release
              ? "GATE"
              : "ENV"
            : station.state === "waiting"
              ? "GATE"
              : "READY",
      cause: station.text,
      effect: station.state,
      next: "",
      why: release
        ? (line.releasePr?.failures.map((f) => f.reason ?? f.check).join("; ") ?? "")
        : model.stack.deployable.reason,
      related: release
        ? [
            ...(line.releasePr
              ? [
                  {
                    text: line.releasePr.pr.title,
                    state: "Release PR",
                    ...webUrl(line.releasePr.pr.url),
                  },
                ]
              : []),
            ...(line.release
              ? [
                  {
                    text: line.release.tag,
                    state: line.release.at,
                    ...webUrl(line.release.url),
                  },
                ]
              : []),
          ]
        : [
            ...(line.lane.last
              ? [
                  {
                    text: [line.lane.last.ref, line.lane.last.sha].filter(Boolean).join(" · "),
                    state: `${line.lane.last.state} · ${line.lane.last.createdAt}`,
                  },
                ]
              : []),
            ...model.queue.items
              .filter((item) => item.kind === "stack")
              .map((item) => ({ text: item.text, state: "Environment", inspect: item.id })),
          ],
      evidence: [],
      approval: null,
      actions: [],
      areas,
      provenance: [],
    });
  }
  return undefined;
}

function repositoryLineResult(view: ViewSnapshot, id: string): InspectResult | undefined {
  for (const repo of view.briefing.repositories.rows) {
    for (const section of repo.sections) {
      const line = section.lines.find((line) => line.id === id);
      if (!line) continue;
      return InspectResultSchema.parse({
        id,
        title: line.text,
        class: id.startsWith("alert:") ? "SECURITY" : id.startsWith("issue:") ? "GATE" : "READY",
        cause: line.text,
        effect: line.sub,
        next: "",
        why: line.tag,
        related: [
          { text: line.text, state: section.title, ...webUrl(line.url) },
          { text: repo.name, state: "Repository", inspect: repo.id },
        ],
        evidence: [],
        approval: null,
        actions: [],
        areas: view.areas,
        provenance: [],
      });
    }
  }
  return undefined;
}

/**
 * Watch requests over the port, including queue items, steps, MRs, releases, repositories,
 * the upstream plan and its forks, and what the tree and views select: services, workflow runs,
 * maintenance holds and Horizon themes.
 * One window subscribes at a time: a reload's subscription replaces the previous connection's.
 */
export class WatchRoutes {
  private store: ReturnType<typeof createSnapshotStore> | undefined;
  private seenStore: ReturnType<typeof createSeenStore> | undefined;
  private subscriber: { send: HostSend; cursor: number } | undefined;
  private progress: SweepProgress | undefined;
  private progressSequence = 0;
  private nextSweepAt: string | null = null;
  private forceCooldownUntil: number | null = null;
  private lastSweep: LastSweep | null = null;
  private statusSequence = 0;

  readonly routes: HostRoutes = {
    "view.subscribe": (message, send) => {
      if (message.type !== "view.subscribe") return;
      this.subscriber = { send, cursor: message.payload.fromCursor };
      // The live order: a snapshot, then the progress feed, then the status it settles.
      const replayProgress = () => {
        const progress = this.options.sweepProgress?.() ?? this.progress;
        if (progress) this.sendProgress(progress);
      };
      if (!this.flush(replayProgress)) {
        replayProgress();
        this.sendStatus(send, `sweep-status-replay-${++this.statusSequence}`);
      }
    },
    "view.acknowledge": (message) => {
      if (message.type !== "view.acknowledge") return;
      this.acknowledge(message.payload.cursor);
    },
    "inspect.request": (message, send) => this.inspect(message, send),
    "sweep.request": async (message) => {
      if (message.type !== "sweep.request") return;
      if (!this.options.requestSweep) throw new Error("Watch sweep requests are not configured");
      await this.options.requestSweep(message.payload);
    },
  };

  constructor(private readonly options: WatchRoutesOptions) {}

  /**
   * The stored budget with this host run's schedule state; a store that cannot be read leaves
   * the budget unknown rather than dropping the schedule.
   */
  get status(): SweepStatus {
    let budget: SweepBudget | undefined;
    try {
      budget = this.latest()?.status;
    } catch (error) {
      this.options.onError(error);
    }
    return {
      ...emptySweepStatus(),
      ...budget,
      nextSweepAt: this.nextSweepAt,
      forceCooldownUntil: this.activeForceCooldown,
      schedule: SWEEP_SCHEDULE,
      lastSweep: this.lastSweep,
    };
  }

  /** Records a scheduler transition and sends the subscriber the whole sweep.status. */
  publishStatus(status: SweepSchedulerStatus): void {
    this.nextSweepAt = status.nextSweepAt;
    this.forceCooldownUntil = status.forceCooldownUntil;
    if (
      status.lastSweep &&
      (!this.lastSweep ||
        Date.parse(status.lastSweep.startedAt) >= Date.parse(this.lastSweep.startedAt))
    ) {
      this.lastSweep = status.lastSweep;
    }
    const subscriber = this.subscriber;
    if (!subscriber) return;
    try {
      this.sendStatus(subscriber.send, `sweep-schedule-${++this.statusSequence}`);
    } catch (error) {
      this.options.onError(error);
    }
  }

  private sendStatus(send: HostSend, id: string): void {
    send({
      version: PROTOCOL_VERSION,
      id,
      kind: "event",
      type: "sweep.status",
      payload: this.status,
    });
  }

  private get activeForceCooldown(): number | null {
    return this.forceCooldownUntil !== null &&
      this.forceCooldownUntil > this.options.ctx.clock.now().getTime()
      ? this.forceCooldownUntil
      : null;
  }

  /** Pushes a snapshot newer than the subscriber's cursor, with its sweep status. */
  publish(): void {
    try {
      this.flush();
    } catch (error) {
      this.options.onError(error);
    }
  }

  publishProgress(progress: SweepProgress): void {
    if (
      this.progress &&
      this.progress.sweep !== progress.sweep &&
      Date.parse(progress.startedAt) < Date.parse(this.progress.startedAt)
    )
      return;
    this.progress = progress;
    try {
      this.sendProgress(progress);
    } catch (error) {
      this.options.onError(error);
    }
  }

  private sendProgress(progress: SweepProgress): void {
    this.subscriber?.send({
      version: PROTOCOL_VERSION,
      id: `sweep-progress-${progress.sweep}-${++this.progressSequence}`,
      kind: "event",
      type: "sweep.progress",
      payload: progress,
    });
  }

  /** Wraps a sweeper factory so each committed snapshot is published. */
  sweeper(base: typeof createSweeper = createSweeper): typeof createSweeper {
    return (options) =>
      base({
        ...options,
        persist: {
          ...options.persist,
          save: async (state) => {
            await options.persist.save(state);
            this.publish();
          },
        },
      });
  }

  private latest(): Persisted | undefined {
    this.store ??= createSnapshotStore(this.options.db());
    const record = this.store.latestSnapshot(this.options.fleet);
    return record ? persisted(record) : undefined;
  }

  private seen() {
    this.seenStore ??= createSeenStore(this.options.db());
    return this.seenStore;
  }

  /** The stored acknowledgement; a row this build cannot read counts as never acknowledged. */
  private baseline(): SeenBaseline | undefined {
    const record = this.seen().baseline(this.options.fleet);
    const items = record ? parseSeenItems(record.items) : undefined;
    return record && items
      ? { cursor: record.cursor, at: new Date(record.at).toISOString(), items }
      : undefined;
  }

  /**
   * The baseline for a push. With none stored, the first snapshot pushed becomes it: first
   * sight is quiet, and only what arrives after it counts as arrived.
   */
  private baselineFor(view: ViewSnapshot): SeenBaseline {
    const stored = this.baseline();
    if (stored) return stored;
    const now = this.options.ctx.clock.now().getTime();
    const items = baselineItems(view.briefing);
    this.seen().acknowledge(this.options.fleet, view.cursor, items, now);
    return { cursor: view.cursor, at: new Date(now).toISOString(), items };
  }

  /**
   * Records the briefing the window showed at `cursor` as the seen baseline. It writes only the
   * baseline: stations, the count and the stored snapshots are untouched. Unknown, pruned or
   * older cursors are ignored.
   */
  private acknowledge(cursor: number): void {
    this.store ??= createSnapshotStore(this.options.db());
    const record = this.store.snapshotAt(this.options.fleet, cursor);
    if (!record) return;
    const items = baselineItems(persisted(record).view.briefing);
    this.seen().acknowledge(
      this.options.fleet,
      cursor,
      items,
      this.options.ctx.clock.now().getTime(),
    );
  }

  /** True when it sent a snapshot and its sweep.status. */
  private flush(beforeStatus?: () => void): boolean {
    const subscriber = this.subscriber;
    if (!subscriber) return false;
    const latest = this.latest();
    if (!latest || latest.view.cursor <= subscriber.cursor) return false;
    const cursor = latest.view.cursor;
    subscriber.send({
      version: PROTOCOL_VERSION,
      id: `snapshot-${cursor}`,
      kind: "event",
      type: "view.snapshot",
      payload: {
        ...latest.view,
        seen: seenSince(this.baselineFor(latest.view), latest.view.briefing),
      },
    });
    beforeStatus?.();
    subscriber.send({
      version: PROTOCOL_VERSION,
      id: `sweep-status-${cursor}`,
      kind: "event",
      type: "sweep.status",
      payload: {
        ...latest.status,
        nextSweepAt: this.nextSweepAt,
        forceCooldownUntil: this.activeForceCooldown,
        schedule: SWEEP_SCHEDULE,
        lastSweep: this.lastSweep,
      },
    });
    subscriber.cursor = cursor;
    return true;
  }

  private async inspect(message: Message, send: HostSend): Promise<void> {
    if (message.type !== "inspect.request") return;
    const notFound = (text: string) =>
      send({
        version: PROTOCOL_VERSION,
        id: message.id,
        kind: "response",
        type: "error",
        payload: { code: "not_found", message: text },
      });
    const latest = this.latest();
    const facts = latest?.facts;
    if (!latest || !facts) {
      notFound("No sweep has been persisted for this fleet");
      return;
    }
    const { ctx } = this.options;
    const now = ctx.clock.now();
    const model = buildModel(facts, now, {}, ctx);
    const id = message.payload.id;
    const item = model.queue.items.find((entry) => entry.id === id);
    let result: InspectResult | undefined;
    if (item) {
      result = await inspectResult(
        model,
        item,
        now,
        ctx,
        this.options.exec,
        latest.view.areas,
        this.options.inspect,
      );
    } else if (model.template.steps.some((step) => `${STEP_PREFIX}${step.marker}` === id)) {
      result = stepResult(model, id, ctx, latest.view.areas);
    } else if (mrTitle(model, id)) {
      result = mrResult(mrBoard(model, id, now, ctx), id, mrTitle(model, id), latest.view.areas);
    } else if (id === UPSTREAM_ITEM) {
      result = upstreamPlanResult(inspectUpstreamPlan(model, now), latest.view.areas);
    } else if (id.startsWith(UPSTREAM_PREFIX)) {
      const fork = inspectUpstreamFork(model, id.slice(UPSTREAM_PREFIX.length), now);
      if (fork) result = upstreamForkResult(id, fork, latest.view.areas);
    } else if (id.startsWith(RELEASE_PREFIX)) {
      const month = id.slice(RELEASE_PREFIX.length);
      if (
        isMonth(month) &&
        latest.view.releases.lines.some((line) => line.id === id) &&
        latest.releases !== undefined
      ) {
        const { at, ...reads } = cacheSchema.shape.releases.parse(latest.releases);
        result = releaseResult(
          releaseDoc(
            monthFacts({ ...reads, ...(at === undefined ? {} : { at }) }, month, now, ctx),
            readNotes(this.options.appData, month),
            now,
          ),
          latest.view.areas,
        );
      }
    } else if (id.startsWith(REPO_PREFIX)) {
      const repo = inspectRepo(model, id, now);
      if (repo) result = repoResult(id, repo, latest.view.areas);
    } else if (id.startsWith(SERVICE_PREFIX)) {
      const service = id.slice(SERVICE_PREFIX.length);
      const fork = inspectUpstreamFork(model, service, now);
      const repo = fork ? undefined : inspectRepo(model, `${REPO_PREFIX}${service}`, now);
      if (fork) result = upstreamForkResult(id, fork, latest.view.areas);
      else if (repo) result = repoResult(id, repo, latest.view.areas);
    } else if (id.startsWith(RUN_PREFIX)) {
      const hit = findRun(facts, id.slice(RUN_PREFIX.length), ctx.stackRepo);
      if (hit) result = runResult(id, hit, coveringItem(model, hit.run), latest.view.areas);
    } else if (id.startsWith(HOLD_PREFIX)) {
      const hold = latest.view.briefing.environment.lanes
        .find((lane) => lane.id === "holds")
        ?.events.find((e) => `${HOLD_PREFIX}${e.id}` === id);
      if (hold) result = holdResult(id, hold, latest.view.briefing, latest.view.areas);
    } else if (id.startsWith(THEME_PREFIX)) {
      const theme = latest.view.briefing.themes.find((t) => `${THEME_PREFIX}${t.id}` === id);
      if (theme)
        result = themeResult(
          id,
          theme,
          latest.view.areas,
          [...latest.view.briefing.focus, ...latest.view.briefing.rest].find(
            (item) => item.id === theme.inspect,
          ),
        );
    } else if (id.startsWith(STATION_PREFIX)) {
      result = stationResult(model, id, now, latest.view.areas);
    } else if (["pr:", "issue:", "alert:"].some((prefix) => id.startsWith(prefix))) {
      result = repositoryLineResult(latest.view, id);
    }
    if (!result) {
      notFound("Nothing in the latest sweep has this id");
      return;
    }
    send({
      version: PROTOCOL_VERSION,
      id: message.id,
      kind: "response",
      type: "inspect.result",
      payload: result,
    });
  }
}
