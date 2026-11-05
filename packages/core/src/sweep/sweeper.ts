// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { Clock } from "../clock.js";
import type { CoreContext } from "../context.js";
import type { ReadRecord } from "../evidence/index.js";
import type { Exec } from "../exec/port.js";
import { AREAS, type AreaName, emptyFacts, type Facts, type Measured } from "../facts.js";
import { buildModel, type Model } from "../model/index.js";
import { errorText } from "../util.js";

export type SweepReads = Partial<Record<AreaName | "persist", readonly ReadRecord[]>>;

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
}

export type SweepArea<C> = {
  [K in AreaName]: {
    readonly name: K;
    readonly read: (input: SweepInput<C>) => Promise<{
      data: NonNullable<Facts[K]["data"]>;
      reads: readonly ReadRecord[];
    }>;
  };
}[AreaName];

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
}

const readRecordSchema: z.ZodType<ReadRecord> = z.strictObject({
  source: z.string().min(1),
  object: z.string().min(1),
  observedAt: z.iso.datetime({ offset: true }),
  completeness: z.union([
    z.strictObject({ kind: z.literal("complete") }),
    z.strictObject({
      kind: z.literal("cut"),
      reason: z.string().min(1),
      read: z.int().nonnegative(),
      total: z.int().nonnegative(),
    }).refine(({ read, total }) => read <= total, "Read count exceeds total"),
  ]),
  failure: z.string().min(1).optional(),
  retainedFrom: z.iso.datetime({ offset: true }).optional(),
  inferred: z.boolean().optional(),
});

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
  private loaded = false;

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
      this.running = this.run(force).finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
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

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
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
    try {
      const cache = structuredClone(this.cache);
      const result = await area.read({
        ctx: this.opts.ctx, exec, clock: this.clock, force,
        facts: structuredClone(this.facts), cache, reads: structuredClone(this.reads),
      });
      const records = z.array(readRecordSchema).parse(result.reads);
      const at = this.clock.now().toISOString();
      const facts = this.opts.factsSchema.parse({
        ...this.facts, [area.name]: { at, data: result.data },
      });
      const validatedCache = this.opts.cacheSchema.parse(cache);
      this.facts = facts;
      this.cache = validatedCache;
      this.reads[area.name] = records.length ? records : [{
        source: area.name, object: area.name, observedAt: at, completeness: { kind: "complete" },
      }];
      return true;
    } catch (error) {
      const at = this.clock.now().toISOString();
      const failure = errorText(error) || "Unknown error";
      previous.error = failure;
      previous.errorAt = at;
      const prior = this.reads[area.name];
      const records: readonly ReadRecord[] = prior?.length ? prior : [{
        source: area.name, object: area.name,
        observedAt: previous.at ?? at, completeness: { kind: "complete" },
      }];
      this.reads[area.name] = records.map((record) => {
        const retainedFrom = previous.data === undefined
          ? undefined
          : record.retainedFrom ?? record.observedAt;
        return {
          ...record, observedAt: at, failure,
          ...(retainedFrom === undefined ? {} : { retainedFrom }),
        };
      });
      return false;
    }
  }

  private async run(force: boolean): Promise<void> {
    const previousPersistFailure = this.reads.persist;
    await this.load();
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
    this.model = buildModel(this.facts, this.clock.now(), {}, this.opts.ctx);
  }
}
