// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type {
  AreaName,
  Envelope,
  InspectResult,
  ReadRecord,
  ValueSource,
  ViewSnapshot,
} from "@spi-code/contracts";
import {
  INSPECT_TABLE,
  type InspectDependencies,
  type InspectScope,
  type InspectSnapshot,
  inspectScope,
} from "../../inspect/resolve.js";

export const NOT_READ = "not read";

export interface InspectAnswer {
  readonly kind: string;
  readonly result: InspectResult;
}

/** Each collector's own read records as the sweep saved them: the areas and the Releases reader. */
export type CollectorReads = Partial<Record<AreaName | "releases", readonly ReadRecord[]>>;

/** The latest persisted sweep, as threads read it. */
export interface SavedSweep {
  readonly view: ViewSnapshot;
  readonly reads: CollectorReads;
  inspect(id: string): Promise<InspectAnswer | undefined>;
}
export type LatestSweep = () => SavedSweep | undefined;

/** Answers ids through the inspect table from the saved sweep alone, naming the row that claimed each one. */
export function latestSweep(
  latest: () => (InspectSnapshot & { readonly reads: CollectorReads }) | undefined,
  { exec: _onDemand, ...saved }: InspectDependencies,
): LatestSweep {
  return () => {
    const snapshot = latest();
    if (!snapshot) return undefined;
    let scope: InspectScope | undefined;
    return {
      view: snapshot.view,
      reads: snapshot.reads,
      async inspect(id) {
        scope ??= inspectScope(snapshot, saved);
        const at = scope;
        const row = INSPECT_TABLE.find((entry) => entry.claims(id, at));
        const result = await row?.resolve(id, at);
        return row && result ? { kind: row.kind, result } : undefined;
      },
    };
  };
}

export interface FailedRecords {
  readonly read: number;
  readonly retained: readonly { readonly from: string; readonly reads: number }[];
  readonly lost: number;
}

export interface AreaRead {
  readonly area: string;
  readonly state: Envelope["state"];
  readonly observedAt?: string;
  /** A failed area's records: read this sweep, retained from an earlier read, or failed with nothing kept. */
  readonly records?: FailedRecords | typeof NOT_READ;
}

export interface ReadState {
  readonly read: "read" | "partly read" | typeof NOT_READ;
  readonly areas: readonly AreaRead[];
  readonly notRead: readonly string[];
  /** Failed this sweep with an earlier read on record; its records say what was retained. */
  readonly failed: readonly string[];
}

/** Gives each failed area the split its own records show; a collector with none saved says not read. */
export function withRecords(areas: readonly AreaRead[], reads: CollectorReads): AreaRead[] {
  return areas.map((entry) => {
    if (entry.state !== "failed") return entry;
    const records = (reads as Record<string, readonly ReadRecord[] | undefined>)[entry.area];
    if (!records?.length) return { ...entry, records: NOT_READ };
    const retained = new Map<string, number>();
    let read = 0;
    let lost = 0;
    for (const { failure, retainedFrom } of records) {
      if (retainedFrom !== undefined)
        retained.set(retainedFrom, (retained.get(retainedFrom) ?? 0) + 1);
      else if (failure !== undefined) lost += 1;
      else read += 1;
    }
    const kept = [...retained].map(([from, count]) => ({ from, reads: count }));
    return { ...entry, records: { read, retained: kept, lost } };
  });
}

/** A failed read with nothing retained read nothing, as an unread one did. */
export function readState(
  envelopes: readonly { readonly area: string; readonly envelope: Envelope }[],
): ReadState {
  const areas = envelopes.map(({ area, envelope }) => ({
    area,
    state: envelope.state,
    ...("observedAt" in envelope && envelope.observedAt !== undefined
      ? { observedAt: envelope.observedAt }
      : {}),
  }));
  const notRead = areas
    .filter(({ state, observedAt }) => state === "unread" || observedAt === undefined)
    .map(({ area }) => area);
  const failed = areas
    .filter(({ state, observedAt }) => state === "failed" && observedAt !== undefined)
    .map(({ area }) => area);
  const read =
    notRead.length === areas.length
      ? NOT_READ
      : notRead.length + failed.length === 0
        ? "read"
        : "partly read";
  return { read, areas, notRead, failed };
}

/** The named areas' envelopes in the saved sweep; an area it lacks counts as unread. */
export function areaEnvelopes(view: ViewSnapshot, names: readonly AreaName[]) {
  return names.map((area) => ({
    area,
    envelope: view.areas.find((entry) => entry.area === area)?.envelope ?? {
      source: area,
      state: "unread" as const,
    },
  }));
}

/** The provenance at a pointer or its nearest recorded ancestor. */
export function sourceAt(view: ViewSnapshot, path: string): ValueSource | undefined {
  for (let at = path; at.length > 0; at = at.slice(0, at.lastIndexOf("/"))) {
    const source = view.provenance.find((entry) => entry.path === at);
    if (source) return source;
  }
  return undefined;
}

/** The value's own source, else every source recorded below it, as a place's parts carry theirs. */
export function sourcesAt(view: ViewSnapshot, path: string): readonly ValueSource[] {
  const own = sourceAt(view, path);
  if (own) return [own];
  return view.provenance.filter((entry) => entry.path.startsWith(`${path}/`));
}

/** A value's read state from its provenance, or undefined when no source is recorded for it. */
export function readStateAt(view: ViewSnapshot, path: string): ReadState | undefined {
  const sources = sourcesAt(view, path);
  if (!sources.length) return undefined;
  const own = new Map(
    sources.flatMap(({ envelope }) => (envelope ? [[envelope.source, envelope] as const] : [])),
  );
  return readState([
    ...areaEnvelopes(view, [...new Set(sources.flatMap(({ areas }) => areas))]),
    ...[...own].map(([area, envelope]) => ({ area, envelope })),
  ]);
}

/** A place whose own reader did not read reads as not read, whatever else it drew on. */
export function governedBy(state: ReadState, area: string): ReadState {
  return state.notRead.includes(area) ? { ...state, read: NOT_READ } : state;
}
