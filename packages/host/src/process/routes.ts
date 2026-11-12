// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { DatabaseSync } from "node:sqlite";
import {
  type LastSweep,
  type Message,
  PROTOCOL_VERSION,
  type Since,
  type SweepProgress,
  type SweepStatus,
  SweepStatusSchema,
  type ViewSnapshot,
  ViewSnapshotSchema,
  type WatchBriefing,
} from "@spi-code/contracts";
import {
  buildModel,
  type CoreContext,
  cacheSchema,
  createSweeper,
  type Exec,
  emptyFacts,
  type Facts,
  factsSchema,
  type InspectOptions,
  runsObservedAt,
  SWEEP_MS,
  sinceOf,
  sweepStateSchema,
} from "@spi-code/core";
import { z } from "zod";
import { resolveInspect } from "../inspect/resolve.js";
import { createSeenStore } from "../store/seen.js";
import { createSnapshotStore, type SnapshotRecord } from "../store/snapshots.js";
import { sweepEvidence } from "../sweep/evidence.js";
import { emptySweepStatus, SWEEP_SCHEDULE, type SweepSchedulerStatus } from "../sweep/status.js";
import {
  baselineItems,
  freshIds,
  parseSeenItems,
  type SeenBaseline,
  seenSince,
  sinceStart,
} from "../watch/seen.js";
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
  /** The sweep state the view was projected from, unparsed. */
  state: unknown;
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
    state: record.facts,
  };
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
    if (!record || !items) return undefined;
    const at = new Date(record.at);
    const observed = record.observedAt === null ? undefined : new Date(record.observedAt);
    return {
      cursor: record.cursor,
      ...(Number.isNaN(at.getTime()) ? {} : { at: at.toISOString() }),
      ...(observed === undefined || Number.isNaN(observed.getTime())
        ? {}
        : { observedAt: observed.toISOString() }),
      items,
    };
  }

  /** When the snapshot's runs were read, from its persisted sweep; null when it cannot tell. */
  private runsObserved(snapshot: Persisted): number | null {
    const state = sweepStateSchema(factsSchema, cacheSchema).safeParse(snapshot.state);
    if (!state.success) return null;
    try {
      const { reads } = sweepEvidence(state.data, SWEEP_MS, new Date(snapshot.view.sweptAt));
      const at = runsObservedAt(state.data.facts, reads);
      const time = at === undefined ? Number.NaN : Date.parse(at);
      return Number.isSafeInteger(time) ? time : null;
    } catch (error) {
      this.options.onError(error);
      return null;
    }
  }

  /**
   * Seeds the baseline for a first push: first sight is quiet, and only what arrives after it
   * counts as arrived.
   */
  private seed(latest: Persisted): SeenBaseline {
    const { view } = latest;
    const now = this.options.ctx.clock.now().getTime();
    const items = baselineItems(view.briefing);
    const observed = this.runsObserved(latest);
    this.seen().acknowledge(this.options.fleet, view.cursor, items, now, observed);
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
    const snapshot = persisted(record);
    this.seen().acknowledge(
      this.options.fleet,
      cursor,
      baselineItems(snapshot.view.briefing),
      this.options.ctx.clock.now().getTime(),
      this.runsObserved(snapshot),
    );
  }

  /**
   * The briefing as of the operator's last look: each place's fresh items, and the since pips
   * from the baseline's start. Without a prior baseline nothing is fresh and since stays at 24 hours.
   */
  private seenBriefing(latest: Persisted, prior: SeenBaseline | undefined): WatchBriefing {
    const { briefing } = latest.view;
    const start = sinceStart(prior);
    const since = start === undefined ? undefined : this.sinceFrom(latest, start);
    return {
      ...briefing,
      ...(briefing.places
        ? {
            places: briefing.places.map((row) => ({
              ...row,
              fresh: { itemIds: freshIds(prior, row.itemIds, briefing) },
            })),
          }
        : {}),
      ...(since ? { since } : {}),
    };
  }

  /** The since pips rebuilt from the persisted sweep from `at`; undefined keeps the stored ones. */
  private sinceFrom(latest: Persisted, at: string): Since | undefined {
    const stored = latest.view.briefing.since;
    if (!stored || stored.basis === "stale") return undefined;
    const state = sweepStateSchema(factsSchema, cacheSchema).safeParse(latest.state);
    if (!state.success) return undefined;
    try {
      const now = new Date(latest.view.sweptAt);
      const { reads } = sweepEvidence(state.data, SWEEP_MS, now);
      const model = buildModel(state.data.facts, now, {}, this.options.ctx);
      return sinceOf(model, state.data.facts, now, SWEEP_MS, at, reads);
    } catch (error) {
      this.options.onError(error);
      return undefined;
    }
  }

  /** True when it sent a snapshot and its sweep.status. */
  private flush(beforeStatus?: () => void): boolean {
    const subscriber = this.subscriber;
    if (!subscriber) return false;
    const latest = this.latest();
    if (!latest || latest.view.cursor <= subscriber.cursor) return false;
    const cursor = latest.view.cursor;
    const prior = this.baseline();
    const baseline = prior ?? this.seed(latest);
    subscriber.send({
      version: PROTOCOL_VERSION,
      id: `snapshot-${cursor}`,
      kind: "event",
      type: "view.snapshot",
      payload: {
        ...latest.view,
        briefing: this.seenBriefing(latest, prior),
        seen: seenSince(baseline, latest.view.briefing),
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
    const result = await resolveInspect(
      { view: latest.view, facts, releases: latest.releases },
      message.payload.id,
      this.options,
    );
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
