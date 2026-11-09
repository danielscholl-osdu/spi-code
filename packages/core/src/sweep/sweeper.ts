// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { Clock } from "../clock.js";
import type { CoreContext } from "../context.js";
import { envelopeOf, type ReadCompleteness, type ReadRecord } from "../evidence/index.js";
import type { Exec } from "../exec/port.js";
import { AREAS, type AreaName, emptyFacts, type Facts, type Measured } from "../facts.js";
import { ForgeError } from "../forge.js";
import { buildModel, type Model } from "../model/index.js";
import { errorText } from "../util.js";
import { readRecordSchema } from "./record.js";

export type SweepReads = Partial<Record<AreaName | "persist", readonly ReadRecord[]>>;

export type SweepSource = AreaName | "releases";
export type SweepReadDecision = boolean | {
  readonly state: "deferred" | "skipped" | "throttled";
  readonly reason: string;
};

export type SweepSourceProgress = {
  readonly kind: "source";
  readonly source: SweepSource;
} & (
  | { readonly state: "reading"; readonly startedAt: string }
  | {
    readonly state: "read" | "cut" | "deferred" | "skipped" | "throttled" | "failed";
    readonly endedAt: string;
    readonly reason?: string;
    readonly completeness?: ReadCompleteness;
  }
);

export type SweepProgress = SweepSourceProgress | {
  readonly kind: "failed";
  readonly endedAt: string;
  readonly reason: string;
};
/** Synchronous source boundaries; only the caller's snapshot commit confirms success. */
export type SweepProgressHook = (event: SweepProgress) => void;

export function sweepReadProgress(
  source: SweepSource, records: readonly ReadRecord[], endedAt: string,
): Exclude<SweepSourceProgress, { state: "reading" }> {
  const { completeness } = envelopeOf(records, { intervalMs: 0, now: Date.parse(endedAt) });
  const failure = records.find((record) => record.failure !== undefined)?.failure;
  const reason = failure ?? (completeness.kind === "cut" ? completeness.reason : undefined);
  return {
    kind: "source", source, endedAt,
    state: failure !== undefined ? "failed" : completeness.kind === "cut" ? "cut" : "read",
    completeness,
    ...(reason === undefined ? {} : { reason }),
  };
}

export function sweepFailureProgress(
  source: SweepSource, error: unknown, records: readonly ReadRecord[], endedAt: string,
): Exclude<SweepSourceProgress, { state: "reading" }> {
  return {
    ...sweepReadProgress(source, records, endedAt),
    state: error instanceof ForgeError && error.kind === "throttle" ? "throttled" : "failed",
    reason: errorText(error) || "Unknown error",
  };
}

export interface SweepState<C> {
  facts: Facts;
  cache: C;
  reads: SweepReads;
}

export interface SweepPersist<C> {
  load(): Promise<unknown>;
  save(state: SweepState<C>): Promise<void>;
}

export interface SweepInput<C> extends SweepState<C> {
  readonly ctx: CoreContext;
  readonly exec: Exec;
  readonly clock: Clock;
  readonly force: boolean;
  readonly progress?: SweepProgressHook;
}

export type SweepArea<C> = {
  [K in AreaName]: {
    readonly name: K;
    readonly shouldRead?: (input: SweepInput<C>) => SweepReadDecision;
    readonly read: (input: SweepInput<C>) => Promise<{
      data: NonNullable<Facts[K]["data"]>;
      reads: readonly ReadRecord[];
    }>;
  };
}[AreaName];

/** Polls what is in flight between sweeps; the host owns the timer. */
export interface SweepInflight<C> {
  has(facts: Facts, ctx: CoreContext): boolean;
  poll(input: SweepInput<C>): Promise<{ changed: boolean; settled: boolean }>;
}

export interface SweeperOptions<C> {
  readonly ctx: CoreContext;
  readonly exec: Exec;
  readonly persist: SweepPersist<C>;
  readonly clock?: Clock;
  readonly areas: readonly SweepArea<C>[];
  readonly factsSchema: z.ZodType<Facts>;
  readonly cacheSchema: z.ZodType<C>;
  readonly emptyCache: () => C;
  readonly prune?: (facts: Facts, cache: C, now: Date) => void;
  readonly context?: (facts: Facts, cache: C) => CoreContext;
  readonly beforeSweep?: (state: SweepState<C>) => void;
  readonly afterAreas?: (input: SweepInput<C>) => Promise<void>;
  readonly replay?: () => Promise<unknown>;
  readonly inflight?: SweepInflight<C>;
  readonly progress?: SweepProgressHook;
}

/** Callers supply the collector-owned schemas; core validates both load and save. */
export function sweepStateSchema<C>(factsSchema: z.ZodType<Facts>, cacheSchema: z.ZodType<C>) {
  return z.strictObject({
    facts: factsSchema,
    cache: cacheSchema,
    reads: z.partialRecord(z.enum([...AREAS, "persist"]), z.array(readRecordSchema)),
  });
}

export class Sweeper<C> {
  facts = emptyFacts();
  cache: C;
  reads: SweepReads = {};
  model: Model;
  readonly clock: Clock;
  private readonly schema;
  private running: Promise<void> | undefined;
  private loading: Promise<void> | undefined;
  private polling: Promise<void> | undefined;
  private sweeps = 0;

  constructor(private readonly opts: SweeperOptions<C>) {
    const names = opts.areas.map((area) => area.name);
    if (new Set(names).size !== names.length) throw new RangeError("Duplicate sweep area");
    this.clock = opts.clock ?? opts.ctx.clock;
    this.schema = sweepStateSchema(opts.factsSchema, opts.cacheSchema);
    this.cache = opts.cacheSchema.parse(opts.emptyCache());
    this.model = buildModel(this.facts, this.clock.now(), {}, opts.ctx);
  }

  get sweeping(): boolean {
    return this.running !== undefined;
  }

  sweep({ force = false }: { force?: boolean } = {}): Promise<void> {
    if (!this.running) {
      this.sweeps++;
      this.running = this.run(force).catch((error: unknown) => {
        this.opts.progress?.({
          kind: "failed", endedAt: this.clock.now().toISOString(),
          reason: errorText(error) || "Unknown error",
        });
        throw error;
      }).finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  /** Whether a run is in flight that pollInflight would follow. */
  hasInflight(): boolean {
    return !this.opts.replay && !!this.opts.inflight?.has(this.facts, this.context());
  }

  /**
   * Re-read what is in flight without a full sweep. Recomposes when a run moved
   * and sweeps once one settles. A sweep in progress wins: polling yields to it.
   */
  pollInflight(): Promise<void> {
    if (this.running || !this.opts.inflight || this.opts.replay) return Promise.resolve();
    this.polling ??= this.poll(this.opts.inflight).finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }

  private async poll(inflight: SweepInflight<C>): Promise<void> {
    await this.load();
    if (this.running || !inflight.has(this.facts, this.context())) return;
    const generation = this.sweeps;
    const input: SweepInput<C> = {
      ctx: this.context(), exec: this.opts.exec, clock: this.clock, force: false,
      facts: structuredClone(this.facts), cache: structuredClone(this.cache),
      reads: structuredClone(this.reads),
    };
    const { changed, settled } = await inflight.poll(input);
    // A sweep that started meanwhile reads everything afresh; this poll is stale.
    if (this.sweeps !== generation) return;
    const state = this.schema.parse({ facts: input.facts, cache: input.cache, reads: input.reads });
    this.facts = state.facts;
    this.cache = state.cache;
    this.reads = state.reads;
    if (changed) this.rebuild();
    if (settled) await this.sweep();
  }

  private failure(object: string, error: unknown): void {
    this.reads.persist = [{
      source: "persist",
      object,
      observedAt: this.clock.now().toISOString(),
      completeness: { kind: "complete" },
      failure: errorText(error) || "Unknown error",
    }];
  }

  private load(): Promise<void> {
    this.loading ??= this.restore();
    return this.loading;
  }

  private async restore(): Promise<void> {
    let stored: unknown;
    try {
      stored = await this.opts.persist.load();
    } catch (error) {
      this.failure("load", error);
      return;
    }
    if (stored === undefined || stored === null) return;
    const parsed = this.schema.safeParse(stored);
    if (parsed.success) {
      this.facts = parsed.data.facts;
      this.cache = parsed.data.cache;
      this.reads = parsed.data.reads;
      delete this.reads.persist;
      this.rebuild();
      return;
    }
    const frame = this.schema.extend({ cache: z.unknown() }).safeParse(stored);
    if (frame.success) {
      this.facts = frame.data.facts;
      this.reads = frame.data.reads;
      delete this.reads.persist;
      this.rebuild();
    }
    this.failure(frame.success ? "cache" : "state", `Invalid persisted state: ${parsed.error.message}`);
  }

  private async area(area: SweepArea<C>, exec: Exec, force: boolean): Promise<boolean> {
    const previous: Measured<unknown> = this.facts[area.name];
    let outcome: SweepSourceProgress | undefined;
    let success = true;
    try {
      const cache = structuredClone(this.cache);
      const input = {
        ctx: this.context(), exec, clock: this.clock, force,
        facts: structuredClone(this.facts), cache, reads: structuredClone(this.reads),
      };
      const decision = area.shouldRead?.(input) ?? true;
      if (decision !== true) {
        this.cache = this.opts.cacheSchema.parse(cache);
        this.opts.progress?.({
          kind: "source", source: area.name, endedAt: this.clock.now().toISOString(),
          ...(decision === false ? { state: "skipped" } : decision),
        });
        return true;
      }
      this.opts.progress?.({
        kind: "source", source: area.name, state: "reading",
        startedAt: this.clock.now().toISOString(),
      });
      const result = await area.read(input);
      const records = z.array(readRecordSchema).parse(result.reads);
      const at = this.clock.now().toISOString();
      const facts = this.opts.factsSchema.parse({
        ...this.facts, [area.name]: { at, data: result.data },
      });
      const validatedCache = this.opts.cacheSchema.parse(cache);
      this.facts = facts;
      this.cache = validatedCache;
      const currentRecords: readonly ReadRecord[] = records.length ? records : [{
        source: area.name, object: area.name, observedAt: at, completeness: { kind: "complete" },
      }];
      this.reads[area.name] = currentRecords;
      if (this.opts.progress) outcome = sweepReadProgress(area.name, currentRecords, at);
    } catch (error) {
      const at = this.clock.now().toISOString();
      const failure = errorText(error) || "Unknown error";
      previous.error = failure;
      previous.errorAt = at;
      const prior = this.reads[area.name];
      const records: readonly ReadRecord[] = prior?.length ? prior : [{
        source: area.name, object: area.name,
        observedAt: at, completeness: { kind: "complete" }, failure,
      }];
      const failedRecords = records.map((record) => {
        const retainedFrom = previous.data === undefined
          ? undefined
          : record.retainedFrom ?? (record.failure === undefined ? record.observedAt : undefined);
        return {
          ...record, observedAt: at, failure,
          ...(retainedFrom === undefined ? {} : { retainedFrom }),
        };
      });
      this.reads[area.name] = failedRecords;
      if (this.opts.progress) outcome = sweepFailureProgress(area.name, error, failedRecords, at);
      success = false;
    }
    if (outcome) this.opts.progress?.(outcome);
    return success;
  }

  private async run(force: boolean): Promise<void> {
    const previousPersistFailure = this.reads.persist;
    if (this.opts.replay) {
      const state = this.schema.parse(await this.opts.replay());
      this.facts = state.facts;
      this.cache = state.cache;
      this.reads = state.reads;
      this.rebuild();
      return;
    }
    await this.load();
    this.opts.beforeSweep?.({ facts: this.facts, cache: this.cache, reads: this.reads });
    const started = this.clock.now();
    let calls = 0;
    let errors = 0;
    const exec: Exec = {
      runJSON: <T>(...args: Parameters<Exec["runJSON"]>) => {
        calls++;
        return this.opts.exec.runJSON<T>(...args);
      },
      runText: (...args) => {
        calls++;
        return this.opts.exec.runText(...args);
      },
    };
    for (const area of this.opts.areas) {
      if (!(await this.area(area, exec, force))) errors++;
    }
    await this.opts.afterAreas?.({
      ctx: this.context(), exec, clock: this.clock, force,
      facts: this.facts, cache: this.cache, reads: this.reads,
      progress: this.opts.progress,
    });
    this.facts.sweep = {
      at: started.toISOString(),
      ms: this.clock.now().getTime() - started.getTime(),
      calls, errors,
    };
    this.prune();
    this.rebuild();
    try {
      const { persist: _persist, ...reads } = this.reads;
      await this.opts.persist.save(this.schema.parse({
        facts: this.facts, cache: this.cache, reads,
      }));
      if (this.reads.persist === previousPersistFailure) delete this.reads.persist;
    } catch (error) {
      this.failure("save", error);
      throw error;
    }
  }

  prune(): void {
    this.opts.prune?.(this.facts, this.cache, this.clock.now());
  }

  rebuild(): void {
    this.model = buildModel(this.facts, this.clock.now(), {}, this.context());
  }

  private context(): CoreContext {
    return this.opts.context?.(this.facts, this.cache) ?? this.opts.ctx;
  }
}
