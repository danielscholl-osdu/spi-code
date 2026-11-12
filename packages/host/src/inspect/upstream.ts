// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type AreaEnvelope, type InspectResult, InspectResultSchema } from "@spi-code/contracts";
import { UPSTREAM_ITEM, type UpstreamBoard } from "@spi-code/core";
import { appActions } from "../watch/project.js";
import { webUrl } from "./shared.js";

/** The board's untitled lead rows, whose first line becomes Effect and so stays out of Related. */
function untitledLead(board: UpstreamBoard) {
  const lead = board.sections[0];
  return lead?.kind === "rows" && lead.title === undefined ? lead : undefined;
}

export function upstreamPlanResult(
  board: UpstreamBoard,
  areas: readonly AreaEnvelope[],
): InspectResult {
  const rows = board.sections[0];
  const next = board.sections.find((section) => section.kind === "cards")?.items[0];
  const lead = untitledLead(board);
  return InspectResultSchema.parse({
    id: UPSTREAM_ITEM,
    title: board.title,
    class: board.header.status.tone === "error" ? "TOOLCHAIN" : "ROLLOUT",
    cause: rows?.kind === "rows" ? (rows.items[1]?.text ?? board.title) : board.title,
    effect: rows?.kind === "rows" ? (rows.items[0]?.text ?? "") : "",
    next: next?.title ?? "",
    why: board.header.status.label,
    evidence: [],
    related: board.sections.flatMap((section): InspectResult["related"] => {
      if (section === lead) return [];
      const state = section.title ?? "";
      switch (section.kind) {
        case "rows":
          return section.items.map((row) => ({
            text: [row.chip?.label, row.text, row.trailing].filter(Boolean).join(" · "),
            state,
            ...(row.action ? { inspect: row.action.payload.id } : webUrl(row.href)),
          }));
        case "cards":
          return section.items.flatMap((card) =>
            card.fields.map((field) => ({
              text: field.value,
              state,
              ...webUrl(field.href),
            })),
          );
        case "bars":
          return section.items.map((bar) => ({
            text: `${bar.label}: ${bar.trailing}`,
            state,
          }));
        case "table":
          return section.rows.map((row) => ({
            text: section.columns
              .map(({ key, label }) => {
                const cell = row[key];
                return `${label}: ${typeof cell === "string" ? cell : (cell?.value ?? cell?.badges?.map((badge) => badge.text).join(", ") ?? "")}`;
              })
              .join(" · "),
            state,
            ...webUrl(typeof row.fork === "object" ? row.fork.href : undefined),
          }));
      }
      throw new TypeError("Unsupported upstream inspector section");
    }),
    approval: null,
    actions: appActions(
      board.sections.flatMap((s) =>
        s.kind === "cards" ? s.items.flatMap((card) => card.actions ?? []) : [],
      ),
    ),
    areas,
    provenance: [],
  });
}

export function upstreamForkResult(
  id: string,
  board: UpstreamBoard,
  areas: readonly AreaEnvelope[],
): InspectResult {
  const { label, tone } = board.header.status;
  const lead = untitledLead(board);
  return InspectResultSchema.parse({
    ...upstreamPlanResult(board, areas),
    id,
    class:
      label === "SYNC HALTS"
        ? "HALT"
        : label === "UNREAD"
          ? "UNREAD"
          : tone === "error"
            ? "TOOLCHAIN"
            : tone === "ok"
              ? "READY"
              : "ROLLOUT",
    cause: board.title,
    effect: lead ? (lead.items[0]?.text ?? "") : board.header.chip,
  });
}
