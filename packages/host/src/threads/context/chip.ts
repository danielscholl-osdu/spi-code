// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ReadRecord } from "@spi-code/contracts";
import type { JsonValue } from "@spi-code/threads";
import { type PlaceRead, SERVICE_PLACE } from "./places.js";
import { redactSpiValue, type SpiRedactor } from "./redaction.js";
import {
  type CollectorReads,
  type InspectAnswer,
  type ReadState,
  readState,
  withRecords,
} from "./sweep.js";
export const CHIP_BYTE_BUDGET = 6000;

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
  readonly bytes: number;
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

type Draft = {
  readonly id: string;
  readonly sweptAt: string;
  readonly evidence: readonly (ReadRecord | string)[];
} & PackedChip["chip"];

const PLACE_TOOLS: Readonly<Record<string, string>> = {
  "place:upstream": "spi_radar",
  "place:engineering-system": "spi_template",
  "place:security": "spi_security",
  "place:releases": "spi_release_notes",
  "place:environment": "spi_stack",
  "place:program": "spi_brief",
};

function trim(chip: Draft, journal: SpiRedactor): PackedChip["chip"] {
  const kept: Record<string, JsonValue> = {};
  const evidence: string[] = [];
  for (const key of TRIMMED_CHIP_KEEPS) {
    if (key === "evidence") kept.evidence = evidence;
    else if (chip[key] !== undefined) kept[key] = chip[key];
  }
  const left = Object.keys(chip).filter((key) => !Object.hasOwn(kept, key));
  const tool =
    chip.kind === "place"
      ? chip.id.startsWith(SERVICE_PLACE)
        ? "spi_line"
        : PLACE_TOOLS[chip.id]
      : "spi_inspect";
  kept.trimmed = `Over ${CHIP_BYTE_BUDGET} UTF-8 bytes, so this chip left out ${left.join(", ")}. Read records are kept as references. Use ${tool ?? "spi_inspect"} for the rest.`;

  let used = Buffer.byteLength(JSON.stringify(kept));
  let count = 0;
  for (const entry of chip.evidence) {
    const safe = typeof entry === "string" ? entry : journal.value(reference(entry));
    if (typeof safe !== "string") throw new Error("Invalid evidence reference.");
    used += Buffer.byteLength(JSON.stringify(safe)) + Number(evidence.length > 0);
    if (used > CHIP_BYTE_BUDGET) break;
    evidence.push(safe);
    const evidenceLeftOut = chip.evidence.length - evidence.length;
    const countBytes = evidenceLeftOut
      ? Buffer.byteLength(JSON.stringify({ evidenceLeftOut })) - 1
      : 0;
    if (used + countBytes <= CHIP_BYTE_BUDGET) count = evidence.length;
  }
  evidence.length = count;
  const evidenceLeftOut = chip.evidence.length - count;
  return evidenceLeftOut ? { ...kept, evidenceLeftOut } : kept;
}

/** Packs one inspect answer within PS-14's budget, keeping whole evidence references. */
export function packChip(
  answer: InspectAnswer,
  sweep: ChipSweep,
  redactor: SpiRedactor,
): ChipOutcome {
  return pack(full(answer, sweep), redactor);
}

export function packPlace(
  id: string,
  found: PlaceRead,
  sweep: ChipSweep,
  redactor: SpiRedactor,
): ChipOutcome {
  return pack(placeFull(id, found, sweep), redactor);
}

function pack(draft: Record<string, unknown>, redactor: SpiRedactor): ChipOutcome {
  try {
    const whole = redactSpiValue(draft, redactor) as Draft;
    const { id, sweptAt } = whole;
    if (typeof id !== "string" || typeof sweptAt !== "string" || !Array.isArray(whole.evidence)) {
      return { ok: false, reason: "Context chip withheld." };
    }
    const fullContent = JSON.stringify(whole);
    const trimmed = Buffer.byteLength(fullContent) > CHIP_BYTE_BUDGET;
    const chip = trimmed ? trim(whole, redactor) : whole;
    const content = trimmed ? JSON.stringify(chip) : fullContent;
    const bytes = Buffer.byteLength(content);
    if (bytes <= CHIP_BYTE_BUDGET) {
      return { ok: true, chip: { id, sweptAt, trimmed, bytes, chip, content } };
    }
    return {
      ok: false,
      reason: `The context for ${id} is over ${CHIP_BYTE_BUDGET} UTF-8 bytes even without evidence references.`,
    };
  } catch {
    return { ok: false, reason: "Context chip withheld." };
  }
}
