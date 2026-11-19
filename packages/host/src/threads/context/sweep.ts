// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type {
  AreaName,
  Envelope,
  InspectResult,
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

/** The latest persisted sweep, as threads read it. */
export interface SavedSweep {
  readonly view: ViewSnapshot;
  inspect(id: string): Promise<InspectAnswer | undefined>;
}
export type LatestSweep = () => SavedSweep | undefined;

/** Answers ids through the inspect table, naming the row that claimed each one. */
export function latestSweep(
  latest: () => InspectSnapshot | undefined,
  deps: InspectDependencies,
): LatestSweep {
  return () => {
    const snapshot = latest();
    if (!snapshot) return undefined;
    let scope: InspectScope | undefined;
    return {
      view: snapshot.view,
      async inspect(id) {
        scope ??= inspectScope(snapshot, deps);
        const at = scope;
        const row = INSPECT_TABLE.find((entry) => entry.claims(id, at));
        const result = await row?.resolve(id, at);
        return row && result ? { kind: row.kind, result } : undefined;
      },
    };
  };
}

export interface AreaRead {
  readonly area: string;
  readonly state: Envelope["state"];
  readonly observedAt?: string;
}

export interface ReadState {
  readonly read: "read" | "partly read" | typeof NOT_READ;
  readonly areas: readonly AreaRead[];
  readonly notRead: readonly string[];
  /** Failed this sweep; the value shown is the read retained from the area's observed time. */
  readonly failed: readonly string[];
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
