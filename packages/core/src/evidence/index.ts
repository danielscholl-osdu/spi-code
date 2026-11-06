// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

export type ReadCompleteness =
  | { readonly kind: "complete" }
  | {
      readonly kind: "cut";
      readonly reason: string;
      readonly read: number;
      readonly total: number;
    };

export interface ReadRecord {
  readonly source: string;
  readonly object: string;
  readonly observedAt: string;
  readonly completeness: ReadCompleteness;
  readonly failure?: string;
  readonly retainedFrom?: string;
  readonly inferred?: boolean;
}

export type EvidenceState = "fresh" | "stale" | "incomplete" | "failed" | "unread";

export interface EvidenceEnvelope {
  readonly state: EvidenceState;
  readonly observedAt?: string;
  readonly completeness: ReadCompleteness;
  readonly inferred: boolean;
  readonly records: readonly ReadRecord[];
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new RangeError(`Invalid timestamp: ${value}`);
  return parsed;
}

function nonnegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`Invalid ${name}: ${value}`);
}

type CutCompleteness = Extract<ReadCompleteness, { kind: "cut" }>;

function sourceName(source: string): string {
  return source.split("/").filter(Boolean).at(-1) ?? source;
}

/**
 * One cut read stands as recorded. Several sum their read and total (complete reads
 * carry no counts) and the reason names how many were cut, in which sources, and why.
 */
function mergeCuts(cuts: readonly { source: string; cut: CutCompleteness }[]): ReadCompleteness {
  const [first] = cuts;
  if (first === undefined) return { kind: "complete" };
  if (cuts.length === 1) return first.cut;
  const names = [...new Set(cuts.map(({ source }) => sourceName(source)))].sort();
  const reasons = [...new Set(cuts.map(({ cut }) => cut.reason))].sort();
  return {
    kind: "cut",
    reason: `${cuts.length} reads cut in ${names.join(", ")}: ${reasons.join("; ")}`,
    read: cuts.reduce((sum, { cut }) => sum + cut.read, 0),
    total: cuts.reduce((sum, { cut }) => sum + cut.total, 0),
  };
}

/** Records describe current reads, not a history of superseded attempts. */
export function envelopeOf(
  records: readonly ReadRecord[],
  { intervalMs, now }: { readonly intervalMs: number; readonly now: number },
): EvidenceEnvelope {
  nonnegative(intervalMs, "intervalMs");
  if (!Number.isFinite(now)) throw new RangeError(`Invalid now: ${now}`);
  let observedAt: string | undefined;
  let oldest = Number.POSITIVE_INFINITY;
  const cuts: { source: string; cut: CutCompleteness }[] = [];
  for (const record of records) {
    timestamp(record.observedAt);
    if (record.completeness.kind === "cut") {
      cuts.push({ source: record.source, cut: record.completeness });
    }
    const time = record.retainedFrom ?? (record.failure === undefined ? record.observedAt : undefined);
    if (time !== undefined && timestamp(time) < oldest) {
      observedAt = time;
      oldest = timestamp(time);
    }
  }
  const completeness = mergeCuts(cuts);
  const state: EvidenceState = records.some((record) => record.failure !== undefined)
    ? "failed"
    : records.length === 0
      ? "unread"
      : completeness.kind === "cut"
        ? "incomplete"
        : now - oldest > 2 * intervalMs
          ? "stale"
          : "fresh";
  return {
    state,
    ...(observedAt === undefined ? {} : { observedAt }),
    completeness,
    inferred: records.length > 0 && records.every((record) => record.inferred === true),
    records,
  };
}

export interface BudgetArea {
  readonly area: string;
  readonly core: boolean;
  readonly estimate: number;
}

export interface BudgetHistory {
  readonly area: string;
  readonly cost: number;
}

export type BudgetDecision =
  | { readonly area: string; readonly kind: "run"; readonly estimate: number }
  | {
      readonly area: string;
      readonly kind: "defer";
      readonly estimate: number;
      readonly reason: "budget unknown" | "insufficient budget";
    }
  | {
      readonly area: string;
      readonly kind: "wait-until-reset";
      readonly estimate: number;
      readonly reason: "insufficient budget";
      readonly until: string;
    };

export interface BudgetPlanInput {
  readonly remaining?: number;
  readonly resetAt?: string;
  readonly history: readonly BudgetHistory[];
  readonly areas: readonly BudgetArea[];
  readonly now: number;
}

export class BudgetPacer {
  readonly floor: number;
  readonly resetBudget: number;

  constructor({ floor, resetBudget }: { readonly floor: number; readonly resetBudget: number }) {
    nonnegative(floor, "floor");
    nonnegative(resetBudget, "resetBudget");
    if (floor > resetBudget) throw new RangeError("floor exceeds resetBudget");
    this.floor = floor;
    this.resetBudget = resetBudget;
  }

  plan({ remaining, resetAt, history, areas, now }: BudgetPlanInput): BudgetDecision[] {
    if (!Number.isFinite(now)) throw new RangeError(`Invalid now: ${now}`);
    if (remaining !== undefined) nonnegative(remaining, "remaining");
    const reset = resetAt === undefined ? undefined : timestamp(resetAt);
    let available = reset !== undefined && now >= reset ? this.resetBudget : remaining;
    const costs = new Map<string, number>();
    for (const entry of history) {
      nonnegative(entry.cost, "history cost");
      costs.set(entry.area, Math.max(costs.get(entry.area) ?? 0, entry.cost));
    }
    const names = new Set<string>();
    return areas.map(({ area, core, estimate: configured }) => {
      if (names.has(area)) throw new RangeError(`Duplicate area: ${area}`);
      names.add(area);
      nonnegative(configured, "estimate");
      const estimate = costs.get(area) ?? configured;
      if (available === undefined) {
        return core
          ? { area, kind: "run", estimate }
          : { area, kind: "defer", estimate, reason: "budget unknown" };
      }
      if (estimate <= available - this.floor) {
        available -= estimate;
        return { area, kind: "run", estimate };
      }
      return reset !== undefined && now < reset && resetAt !== undefined
        ? { area, kind: "wait-until-reset", estimate, reason: "insufficient budget", until: resetAt }
        : { area, kind: "defer", estimate, reason: "insufficient budget" };
    });
  }
}
