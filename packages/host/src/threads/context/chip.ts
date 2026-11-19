// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ReadRecord } from "@spi-code/contracts";
import type { PlaceRead } from "./places.js";
import type { JsonValue, ModelRedactor } from "./seams.js";
import {
  type CollectorReads,
  type InspectAnswer,
  type ReadState,
  readState,
  withRecords,
} from "./sweep.js";
import { estimateTokens, type TokenEstimate } from "./tokens.js";

export const CHIP_TOKEN_BUDGET = 2000;

/** PS-14: an over-budget chip keeps only these, in this order, and says so. */
export const TRIMMED_CHIP_KEEPS = [
  "id",
  "kind",
  "title",
  "sweptAt",
  "completeness",
  "notRead",
  "class",
  "cause",
  "next",
  "evidence",
] as const;

export interface PackedChip {
  readonly id: string;
  readonly sweptAt: string;
  readonly trimmed: boolean;
  readonly tokens: number;
  /** The redacted chip as Copilot receives it; a draft previews it and a message snapshots it. */
  readonly chip: { readonly [key: string]: JsonValue };
  readonly content: string;
}

export type Refusal = { readonly ok: false; readonly reason: string };
export type ChipOutcome = { readonly ok: true; readonly chip: PackedChip } | Refusal;

/** The saved sweep a chip is packed from: its time and each collector's records. */
export interface ChipSweep {
  readonly sweptAt: string;
  readonly reads: CollectorReads;
}

function reference({ source, object, failure, retainedFrom, completeness }: ReadRecord): string {
  const cut =
    completeness.kind === "cut" ? ` (cut ${completeness.read}/${completeness.total})` : "";
  const kept = retainedFrom === undefined ? "" : ` (retained from ${retainedFrom})`;
  return `${source} ${object}${failure === undefined ? "" : " (failed)"}${kept}${cut}`;
}

function gapsOf(state: ReadState, notRead: readonly string[] = []) {
  return [...state.notRead, ...state.failed.map((area) => `${area} failed this sweep`), ...notRead];
}

function full({ kind, result }: InspectAnswer, { sweptAt, reads }: ChipSweep) {
  const state = readState(result.areas ?? []);
  const notRead = gapsOf(state, result.notRead);
  const gaps = result.evidence.some(
    ({ completeness, failure }) => completeness.kind === "cut" || failure !== undefined,
  );
  return {
    id: result.id,
    kind,
    ...(result.title === undefined ? {} : { title: result.title }),
    sweptAt,
    completeness: notRead.length === 0 && !gaps ? "complete" : "partial",
    notRead,
    class: result.class,
    cause: result.cause,
    effect: result.effect,
    next: result.next,
    why: result.why,
    related: result.related,
    ...(result.approval === null ? {} : { approval: result.approval }),
    areas: withRecords(state.areas, reads),
    evidence: result.evidence,
  };
}

/** A place's chip carries its reading; its evidence is the pointer spi_evidence answers. */
function placeFull(id: string, found: PlaceRead, { sweptAt, reads }: ChipSweep) {
  const notRead = gapsOf(found.state);
  return {
    id,
    kind: "place",
    title: found.place,
    sweptAt,
    completeness: notRead.length === 0 ? "complete" : "partial",
    notRead,
    reading: found.reading,
    areas: withRecords(found.state.areas, reads),
    evidence: found.at === undefined ? [] : [found.at],
  };
}

type Draft = { readonly id: string; readonly evidence: readonly (ReadRecord | string)[] } & Record<
  string,
  unknown
>;

function trim(chip: Draft) {
  const kept: Record<string, unknown> = {};
  for (const key of TRIMMED_CHIP_KEEPS) {
    if (key === "evidence") {
      kept.evidence = chip.evidence.map((entry) =>
        typeof entry === "string" ? entry : reference(entry),
      );
    } else if (chip[key] !== undefined) kept[key] = chip[key];
  }
  const left = Object.keys(chip).filter((key) => !(key in kept));
  kept.trimmed = `Over ${CHIP_TOKEN_BUDGET} tokens: left out ${left.join(", ")}; read records kept as references.`;
  return kept;
}

/** Packs one inspect answer within PS-14's budget, or refuses it. Never clips text. */
export function packChip(
  answer: InspectAnswer,
  sweep: ChipSweep,
  redactor: ModelRedactor,
  estimate: TokenEstimate = estimateTokens,
): ChipOutcome {
  return pack(full(answer, sweep), sweep.sweptAt, redactor, estimate);
}

export function packPlace(
  id: string,
  found: PlaceRead,
  sweep: ChipSweep,
  redactor: ModelRedactor,
  estimate: TokenEstimate = estimateTokens,
): ChipOutcome {
  return pack(placeFull(id, found, sweep), sweep.sweptAt, redactor, estimate);
}

function pack(
  whole: Draft,
  sweptAt: string,
  redactor: ModelRedactor,
  estimate: TokenEstimate,
): ChipOutcome {
  for (const [trimmed, draft] of [
    [false, whole],
    [true, trim(whole)],
  ] as const) {
    const chip = redactor.value(draft as JsonValue) as PackedChip["chip"];
    const content = JSON.stringify(chip);
    const tokens = estimate(content);
    if (tokens <= CHIP_TOKEN_BUDGET) {
      return { ok: true, chip: { id: whole.id, sweptAt, trimmed, tokens, chip, content } };
    }
  }
  return {
    ok: false,
    reason: `${whole.id} is over ${CHIP_TOKEN_BUDGET} tokens even trimmed to identity, class, cause, next and evidence references.`,
  };
}
