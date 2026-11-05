// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import {
  type CollectorOptions,
  createSweeper,
  type DoctorView,
  type Exec,
  type ExecOptions,
  INFLIGHT_POLL_MS,
  SWEEP_MS,
} from "@spi-code/core";
import { createLeaseStore, type LeaseIdentity } from "../store/leases.js";
import { createSnapshotStore } from "../store/snapshots.js";
import { projectWatch } from "../watch/project.js";

export const DAY_MS = 24 * 60 * 60_000;

export interface SweepTimers {
  after(ms: number, callback: () => void): () => void;
}

const timers: SweepTimers = {
  after(ms, callback) {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export interface SweepServiceOptions extends Omit<CollectorOptions, "persist" | "replay"> {
  /** Migrated file-backed connection; also used for leases, snapshots and pruning. */
  readonly db: DatabaseSync;
  readonly fleet: string;
  readonly appData: string;
  readonly doctor: () => DoctorView;
  readonly ttlMs?: number;
  readonly intervalMs?: number;
  readonly timers?: SweepTimers;
  readonly onError: (error: unknown) => void;
  readonly createSweeper?: typeof createSweeper;
}

interface Holder {
  identity: LeaseIdentity;
  expiresAt: number;
  abort: AbortController;
  cancelRenew?: () => void;
  sweeper: ReturnType<typeof createSweeper>;
  saves: number;
}

/** One owner per service lifetime, never a reusable PID or configured fleet id. */
export class SweepService {
  readonly owner = randomUUID();
  private readonly leases;
  private readonly snapshots;
  private readonly ttl;
  private readonly interval;
  private readonly timers;
  private readonly prune;
  private holder: Holder | undefined;
  private running: Promise<boolean> | undefined;
  private started = false;
  private cancellations: (() => void)[] = [];

  constructor(private readonly options: SweepServiceOptions) {
    this.ttl = options.ttlMs ?? 60_000;
    this.interval = options.intervalMs ?? SWEEP_MS;
    for (const ms of [this.ttl, this.interval]) {
      if (!Number.isSafeInteger(ms) || ms < 3 || ms > 2_147_483_647) {
        throw new RangeError(
          "Sweep and lease intervals must be integer milliseconds from 3 to 2147483647",
        );
      }
    }
    this.timers = options.timers ?? timers;
    const db = options.db;
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL");
    if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal") {
      throw new Error("Sweep service requires a WAL store");
    }
    this.leases = createLeaseStore(db);
    this.snapshots = createSnapshotStore(db);
    this.prune = db.prepare(`DELETE FROM facts_snapshots WHERE at < ?
      AND cursor NOT IN (SELECT MAX(cursor) FROM facts_snapshots GROUP BY fleet)`);
  }

  get sweeping(): boolean {
    return this.running !== undefined;
  }

  latest(): ViewSnapshot | undefined {
    const record = this.snapshots.latestSnapshot(this.options.fleet);
    if (!record) return undefined;
    if (
      typeof record.envelope !== "object" ||
      record.envelope === null ||
      Array.isArray(record.envelope)
    ) {
      throw new TypeError("Invalid stored Watch envelope");
    }
    return ViewSnapshotSchema.parse({ ...record.envelope, cursor: record.cursor });
  }

  start(): Promise<boolean> {
    if (!this.started) {
      this.started = true;
      this.repeat(this.interval, () => this.sweep());
      this.repeat(INFLIGHT_POLL_MS, () => this.poll());
      this.repeat(DAY_MS, async () => {
        this.prune.run(this.now() - 7 * DAY_MS);
      });
    }
    return this.sweep();
  }

  /** False means another owner holds the fleet; concurrent requests coalesce. */
  sweep(force = false): Promise<boolean> {
    if (!this.started) return Promise.reject(new Error("Sweep service is stopped"));
    this.running ??= this.run(false, force).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const cancel of this.cancellations.splice(0)) cancel();
    const holder = this.holder;
    if (holder) {
      holder.cancelRenew?.();
      holder.abort.abort(new Error("Sweep service stopped"));
      this.holder = undefined;
    }
    try {
      await this.running;
    } catch (error) {
      if (!holder?.abort.signal.aborted || error !== holder.abort.signal.reason) throw error;
    } finally {
      if (holder) this.leases.release(holder.identity.fleet, this.owner, holder.identity.fence);
    }
  }

  private now(): number {
    return this.options.ctx.clock.now().getTime();
  }

  private repeat(ms: number, task: () => Promise<unknown>): void {
    let cancel = () => {};
    const schedule = () => {
      cancel = this.timers.after(ms, () => {
        void task()
          .catch(this.options.onError)
          .finally(() => {
            if (this.started) schedule();
          });
      });
    };
    schedule();
    this.cancellations.push(() => cancel());
  }

  private lose(holder: Holder): void {
    holder.cancelRenew?.();
    holder.abort.abort(new Error("Lease lost: sweep aborted"));
    if (this.holder === holder) this.holder = undefined;
  }

  private guard(holder: Holder): void {
    if (!holder.abort.signal.aborted && this.now() >= holder.expiresAt) this.lose(holder);
    holder.abort.signal.throwIfAborted();
  }

  private acquire(): Holder | undefined {
    const now = this.now();
    const fence = this.leases.acquire(this.options.fleet, this.owner, this.ttl, now);
    if (fence === undefined) return undefined;
    const identity = { fleet: this.options.fleet, owner: this.owner, fence };
    const abort = new AbortController();
    let holder: Holder;
    const prepare = (opts: ExecOptions = {}) => {
      this.guard(holder);
      return {
        ...opts,
        signal: opts.signal ? AbortSignal.any([opts.signal, abort.signal]) : abort.signal,
      };
    };
    const exec: Exec = {
      runJSON: <T>(cmd: string, args: string[], opts?: ExecOptions) =>
        this.options.exec.runJSON<T>(cmd, args, prepare(opts)),
      runText: (cmd, args, opts) => this.options.exec.runText(cmd, args, prepare(opts)),
    };
    try {
      const sweeper = (this.options.createSweeper ?? createSweeper)({
        ...this.options,
        exec,
        persist: {
          load: async () => this.snapshots.latestSnapshot(identity.fleet)?.facts,
          save: async (state) => {
            holder.saves++;
            this.guard(holder);
            const { at, ...releases } = state.cache.releases;
            const { cursor: _cursor, ...view } = projectWatch({
              facts: state.facts,
              reads: state.reads,
              releases: { ...releases, ...(at === undefined ? {} : { at }) },
              releaseRecords: releases.records.map(
                ({ failure, retainedFrom, inferred, ...record }) => ({
                  ...record,
                  ...(failure === undefined ? {} : { failure }),
                  ...(retainedFrom === undefined ? {} : { retainedFrom }),
                  ...(inferred === undefined ? {} : { inferred }),
                }),
              ),
              doctor: this.options.doctor(),
              context: this.options.ctx,
              appData: this.options.appData,
              intervalMs: this.interval,
              cursor: 0,
            });
            this.guard(holder);
            try {
              this.snapshots.writeSnapshot(identity, state, view, this.now());
            } catch (error) {
              this.lose(holder);
              throw error;
            }
          },
        },
      });
      holder = { identity, expiresAt: now + this.ttl, abort, sweeper, saves: 0 };
      this.holder = holder;
      const renew = () => {
        holder.cancelRenew = this.timers.after(Math.floor(this.ttl / 3), () => {
          const at = this.now();
          let renewed: boolean;
          try {
            renewed = this.leases.renew(identity.fleet, this.owner, fence, this.ttl, at);
          } catch (error) {
            this.lose(holder);
            this.options.onError(error);
            return;
          }
          if (!renewed) {
            this.lose(holder);
            this.options.onError(holder.abort.signal.reason);
            return;
          }
          holder.expiresAt = at + this.ttl;
          renew();
        });
      };
      renew();
      return holder;
    } catch (error) {
      this.leases.release(identity.fleet, this.owner, fence);
      throw error;
    }
  }

  private poll(): Promise<boolean> {
    if (this.running || !this.holder?.sweeper.hasInflight()) return Promise.resolve(false);
    this.running = this.run(true, false).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(poll: boolean, force: boolean): Promise<boolean> {
    const holder = this.holder ?? (poll ? undefined : this.acquire());
    if (!holder) return false;
    const startedAt = this.options.ctx.clock.now().toISOString();
    const previousSaves = holder.saves;
    try {
      this.guard(holder);
      if (poll) await holder.sweeper.pollInflight();
      else await holder.sweeper.sweep({ force });
      this.guard(holder);
      return true;
    } finally {
      // A settled in-flight run can itself trigger a full sweep in core.
      if (!poll || holder.saves !== previousSaves) {
        const line = {
          fleet: this.options.fleet,
          cursor: this.snapshots.latestSnapshot(this.options.fleet)?.cursor ?? 0,
          startedAt,
          endedAt: this.options.ctx.clock.now().toISOString(),
          ...holder.sweeper.cache.budget,
        };
        mkdirSync(this.options.appData, { recursive: true });
        appendFileSync(
          join(this.options.appData, "sweep-budget.jsonl"),
          `${JSON.stringify(line)}\n`,
        );
      }
    }
  }
}
