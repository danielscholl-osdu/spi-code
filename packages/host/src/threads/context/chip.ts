// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ReadRecord } from "@spi-code/contracts";
import type { JsonValue, ModelRedactor } from "./seams.js";
import { type InspectAnswer, readState } from "./sweep.js";
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

function reference({ source, object, failure, completeness }: ReadRecord): string {
  const cut =
    completeness.kind === "cut" ? ` (cut ${completeness.read}/${completeness.total})` : "";
  return `${source} ${object}${failure === undefined ? "" : " (failed)"}${cut}`;
}

function full({ kind, result }: InspectAnswer, sweptAt: string) {
  const state = readState(result.areas ?? []);
  const notRead = [
    ...state.notRead,
    ...state.failed.map((area) => `${area} failed; retained earlier read`),
    ...(result.notRead ?? []),
  ];
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
    areas: state.areas,
    evidence: result.evidence,
  };
}

function trim(chip: ReturnType<typeof full>) {
  const kept: Record<string, unknown> = {};
  for (const key of TRIMMED_CHIP_KEEPS) {
    if (key === "evidence") kept.evidence = chip.evidence.map(reference);
    else if (chip[key] !== undefined) kept[key] = chip[key];
  }
  const left = Object.keys(chip).filter((key) => !(key in kept));
  kept.trimmed = `Over ${CHIP_TOKEN_BUDGET} tokens: left out ${left.join(", ")}; read records kept as references.`;
  return kept;
}

/** Packs one inspect answer within PS-14's budget, or refuses it. Never clips text. */
export function packChip(
  answer: InspectAnswer,
  sweptAt: string,
  redactor: ModelRedactor,
  estimate: TokenEstimate = estimateTokens,
): ChipOutcome {
  const whole = full(answer, sweptAt);
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
