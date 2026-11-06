// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { DatabaseSync } from "node:sqlite";
import {
  type AreaEnvelope,
  type Briefing,
  type InspectResult,
  InspectResultSchema,
  type Message,
  PROTOCOL_VERSION,
  type ReadRecord,
  ReadRecordSchema,
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
  UPSTREAM_ITEM,
  UPSTREAM_PREFIX,
  type UpstreamBoard,
  verbsOf,
} from "@spi-code/core";
import { z } from "zod";
import { createSnapshotStore, type SnapshotRecord } from "../store/snapshots.js";
import { appActions, readNotes } from "../watch/project.js";
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

interface Persisted {
  view: ViewSnapshot;
  status: SweepStatus;
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
  const floor = SweepStatusSchema.shape.floor.safeParse(budget?.floor);
  const status = SweepStatusSchema.parse({
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
  for (const record of (entries ?? []).flatMap((entry) => entry.reads)) {
    const parsed = readRecord(record);
    evidence.set(JSON.stringify(parsed), parsed);
  }
  return InspectResultSchema.parse({
    id: item.id,
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

function mrResult(board: MrInspection, id: string, areas: readonly AreaEnvelope[]): InspectResult {
  return InspectResultSchema.parse({
    id,
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

export function upstreamPlanResult(
  board: UpstreamBoard,
  areas: readonly AreaEnvelope[],
): InspectResult {
  const rows = board.sections[0];
  const next = board.sections.find((section) => section.kind === "cards")?.items[0];
  return InspectResultSchema.parse({
    id: UPSTREAM_ITEM,
    class: board.header.status.tone === "error" ? "TOOLCHAIN" : "ROLLOUT",
    cause: rows?.kind === "rows" ? (rows.items[1]?.text ?? board.title) : board.title,
    effect: rows?.kind === "rows" ? (rows.items[0]?.text ?? "") : "",
    next: next?.title ?? "",
    why: board.header.status.label,
    evidence: [],
    related: board.sections.flatMap((section): InspectResult["related"] => {
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
  const lead = board.sections[0];
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
    effect:
      lead?.kind === "rows" && lead.title === undefined
        ? (lead.items[0]?.text ?? "")
        : board.header.chip,
  });
}

const SERVICE_PREFIX = "service:";
const RUN_PREFIX = "run:";
const HOLD_PREFIX = "hold:";
const THEME_PREFIX = "theme:";
const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

type Theme = Briefing["themes"][number];
type EnvEvent = Briefing["environment"]["lanes"][number]["events"][number];

interface RunHit {
  run: RunFact;
  repo: string;
  workflow: string;
}

/**
 * A workflow run the sweep read, wherever it was read: a fork lane, the stack, or an approval.
 * The id is matched as text, so only the exact spelling the views hand over resolves.
 */
function findRun(facts: Facts, key: string, stackRepo: string): RunHit | undefined {
  const is = (r: RunFact) => String(r.id) === key;
  for (const [repo, lanes] of Object.entries(facts.runs.data ?? {})) {
    for (const workflow of ["sync", "template", "cascade", "main"] as const) {
      const run = lanes[workflow].find(is);
      if (run) return { run, repo, workflow };
    }
  }
  for (const [workflow, list] of Object.entries(facts.lifecycle.data ?? {})) {
    const run = list.find(is);
    if (run) {
      const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\//.exec(run.url)?.[1];
      return { run, repo: repo ?? stackRepo, workflow };
    }
  }
  for (const [repo, list] of Object.entries(facts.approvals.data ?? {})) {
    const run = list.find(is);
    if (run) return { run, repo, workflow: "approval" };
  }
  return undefined;
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

/** A Horizon theme no queue item carries, told from the persisted briefing. */
function themeResult(id: string, theme: Theme, areas: readonly AreaEnvelope[]): InspectResult {
  const fork = (state: string) => (f: Theme["certain"][number]) => ({
    text: f.fork,
    state: `${state} · ${f.state}`,
    ...(f.inspect ? { inspect: f.inspect } : webUrl(f.url)),
  });
  return InspectResultSchema.parse({
    id,
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
    ],
    approval: null,
    actions: [],
    areas,
    provenance: [],
  });
}

/**
 * Watch requests over the port, including queue items, steps, MRs, releases, repositories,
 * the upstream plan and its forks, and what the tree and views select: services, workflow runs,
 * maintenance holds and Horizon themes.
 * One window subscribes at a time: a reload's subscription replaces the previous connection's.
 */
export class WatchRoutes {
  private store: ReturnType<typeof createSnapshotStore> | undefined;
  private subscriber: { send: HostSend; cursor: number } | undefined;

  readonly routes: HostRoutes = {
    "view.subscribe": (message, send) => {
      if (message.type !== "view.subscribe") return;
      this.subscriber = { send, cursor: message.payload.fromCursor };
      this.flush();
    },
    "inspect.request": (message, send) => this.inspect(message, send),
  };

  constructor(private readonly options: WatchRoutesOptions) {}

  /** Pushes a snapshot newer than the subscriber's cursor, with its sweep status. */
  publish(): void {
    try {
      this.flush();
    } catch (error) {
      this.options.onError(error);
    }
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

  private flush(): void {
    const subscriber = this.subscriber;
    if (!subscriber) return;
    const latest = this.latest();
    if (!latest || latest.view.cursor <= subscriber.cursor) return;
    const cursor = latest.view.cursor;
    subscriber.send({
      version: PROTOCOL_VERSION,
      id: `snapshot-${cursor}`,
      kind: "event",
      type: "view.snapshot",
      payload: latest.view,
    });
    subscriber.send({
      version: PROTOCOL_VERSION,
      id: `sweep-status-${cursor}`,
      kind: "event",
      type: "sweep.status",
      payload: latest.status,
    });
    subscriber.cursor = cursor;
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
      result = mrResult(mrBoard(model, id, now, ctx), id, latest.view.areas);
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
      if (theme) result = themeResult(id, theme, latest.view.areas);
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
