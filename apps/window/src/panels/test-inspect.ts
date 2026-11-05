// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type InspectResult, InspectResultSchema } from "@spi-code/contracts";

type OracleSection =
  | { kind: "rows"; items: { text: string }[] }
  | { kind: "stats"; items: { label: string; value: string }[] }
  | { kind: "cards"; title?: string; items: { title: string; fields?: Field[] }[] }
  | { kind: "actions"; items: { type: string; label: string }[] };
type Field = { label: string; value: string };
export type OracleBoard = {
  header: { status: { label: string } };
  sections: OracleSection[];
};

const sectionsOf = <K extends OracleSection["kind"]>(board: OracleBoard, kind: K) =>
  board.sections.filter((s): s is Extract<OracleSection, { kind: K }> => s.kind === kind);

// The rib's lede joins the cause and the effect with a space; the effect is its last sentence.
function splitLede(lede: string): { cause: string; effect: string } {
  const at = lede.lastIndexOf(". ");
  if (at < 0) return { cause: "", effect: lede };
  const cause = lede.slice(0, at + 1).trim();
  return { cause: cause === "." ? "" : cause, effect: lede.slice(at + 2).trim() };
}

export function oracleClass(board: OracleBoard): string {
  return board.header.status.label.split(" · ").at(-1) ?? "";
}

export function oracleNext(board: OracleBoard): string {
  return sectionsOf(board, "cards").find((s) => s.title === "Next step")?.items[0]?.title ?? "";
}

export function inspectFromOracle(
  board: OracleBoard,
  id: string,
  overrides: Partial<InspectResult> = {},
): InspectResult {
  const lede = sectionsOf(board, "rows")[0]?.items[0]?.text ?? "";
  const { cause, effect } = splitLede(lede);
  const gap = sectionsOf(board, "stats")
    .flatMap((s) => s.items)
    .map((stat) => `${stat.label} ${stat.value}.`)
    .join(" ");
  const why = sectionsOf(board, "cards")
    .flatMap((s) => s.items)
    .filter((card) => card.title === "Why")
    .flatMap((card) => card.fields ?? [])
    .map((field) => `${field.label}: ${field.value}`)
    .join("; ");
  return InspectResultSchema.parse({
    id,
    class: oracleClass(board),
    cause: cause || gap,
    effect,
    next: oracleNext(board),
    why,
    evidence: [],
    related: [],
    approval: null,
    actions: sectionsOf(board, "actions")
      .flatMap((s) => s.items)
      .map((action) => ({
        id: action.type,
        label: action.label,
        disabledReason: `${action.label} ships in M4 with the action tools.`,
      })),
    ...overrides,
  });
}
