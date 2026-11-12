// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type AreaEnvelope, type InspectResult, InspectResultSchema } from "@spi-code/contracts";
import type { MrInspection } from "@spi-code/core";
import { webUrl } from "./shared.js";

export function mrResult(
  board: MrInspection,
  id: string,
  title: string | undefined,
  areas: readonly AreaEnvelope[],
): InspectResult {
  return InspectResultSchema.parse({
    id,
    title,
    class:
      board.header.status.label === "HALT"
        ? "HALT"
        : board.header.status.label === "TOOLCHAIN"
          ? "TOOLCHAIN"
          : "READY",
    cause: board.sections[0]?.items[0]?.text ?? "",
    effect: board.header.chip ?? "",
    next: "",
    why: board.header.status.label,
    evidence: [],
    related: board.sections.flatMap((section) =>
      section.items.map((row) => ({
        text: [row.text, row.detail].filter(Boolean).join(": "),
        state: [section.title, row.trailing].filter(Boolean).join(" · "),
        ...webUrl(row.href),
      })),
    ),
    approval: null,
    actions: [],
    areas,
    provenance: [],
  });
}
