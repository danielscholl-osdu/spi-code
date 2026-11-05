// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { DatabaseSync } from "node:sqlite";
import {
  type AreaEnvelope,
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
  type ForkEntry,
  Gh,
  Glab,
  type InspectOptions,
  inspectItem,
  type Model,
  type QueueItem,
  verbsOf,
} from "@spi-code/core";
import { z } from "zod";
import { createSnapshotStore, type SnapshotRecord } from "../store/snapshots.js";
import { appActions } from "../watch/project.js";
import { type InspectBody, inspectProvenance } from "../watch/provenance.js";
import type { HostRoutes, HostSend } from "./port.js";

export interface WatchRoutesOptions {
  /** Opens the migrated WAL store on first use; the routes never close it. */
  readonly db: () => DatabaseSync;
  readonly fleet: string;
  readonly ctx: CoreContext;
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
    })
    .optional(),
});

interface Persisted {
  view: ViewSnapshot;
  status: SweepStatus;
  facts: Facts | undefined;
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

/** Core's inspection of an item mapped to the contract's shown values. */
function inspectBody(
  model: Model,
  item: QueueItem,
  now: Date,
  ctx: CoreContext,
  entries: readonly ForkEntry[] | undefined,
  opts: InspectOptions,
): InspectBody {
  const inspection = inspectItem(
    model,
    item,
    now,
    ctx,
    entries ? { others: { id: item.id, entries: [...entries] } } : {},
  );
  const approvals = approvalSection(item, model, opts);
  return {
    class: inspection.class,
    cause: inspection.cause,
    effect: inspection.effect,
    next: inspection.next,
    why: inspection.why.map((field) => `${field.label}: ${field.value}`).join("; "),
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
  };
}

/**
 * Core inspection mapped to the contract, with the FILTERS read for a checkable halt. Each
 * value names the Facts areas behind it, found by rebuilding the model from the sweep's facts;
 * areas are that sweep's envelopes.
 */
export async function inspectResult(
  model: Model,
  item: QueueItem,
  now: Date,
  ctx: CoreContext,
  exec: Exec,
  sweep: { readonly areas: readonly AreaEnvelope[]; readonly facts?: Facts },
  opts: InspectOptions = {},
): Promise<InspectResult> {
  const entries = checkable(item.halt)
    ? await entryAcrossForks(new Gh(exec), new Glab(exec), item.halt, ctx)
    : undefined;
  const show = (from: Model, shown: QueueItem, others: readonly ForkEntry[] | undefined) =>
    inspectBody(from, shown, now, ctx, others, opts);
  const evidence = new Map<string, ReadRecord>();
  for (const record of (entries ?? []).flatMap((entry) => entry.reads)) {
    const parsed = readRecord(record);
    evidence.set(JSON.stringify(parsed), parsed);
  }
  const provenance = inspectProvenance({
    facts: sweep.facts,
    model,
    item,
    entries,
    now,
    rebuild: (facts) => buildModel(facts, now, {}, ctx),
    show,
  });
  return InspectResultSchema.parse({
    id: item.id,
    ...show(model, item, entries),
    evidence: [...evidence.values()],
    areas: sweep.areas,
    provenance,
  });
}

/**
 * Watch requests over the port. One window subscribes at a time: a reload's
 * subscription replaces the previous connection's.
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
    const item = model.queue.items.find((entry) => entry.id === message.payload.id);
    if (!item) {
      notFound("Nothing in the queue has this id");
      return;
    }
    send({
      version: PROTOCOL_VERSION,
      id: message.id,
      kind: "response",
      type: "inspect.result",
      payload: await inspectResult(
        model,
        item,
        now,
        ctx,
        this.options.exec,
        { areas: latest.view.areas, facts },
        this.options.inspect,
      ),
    });
  }
}
