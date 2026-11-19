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

/** A value's read state from its provenance, or undefined when no source is recorded for it. */
export function readStateAt(view: ViewSnapshot, path: string): ReadState | undefined {
  const source = sourceAt(view, path);
  if (!source) return undefined;
  return readState([
    ...areaEnvelopes(view, source.areas),
    ...(source.envelope ? [{ area: source.envelope.source, envelope: source.envelope }] : []),
  ]);
}
