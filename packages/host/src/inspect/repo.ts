// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type AreaEnvelope,
  type InspectResult,
  InspectResultSchema,
  type ViewSnapshot,
} from "@spi-code/contracts";
import type { RepoInspection } from "@spi-code/core";
import { webUrl } from "./shared.js";

/** A repository's tabs flatten into related rows, each stating its tab, section and marks. */
export function repoResult(
  id: string,
  repo: RepoInspection,
  areas: readonly AreaEnvelope[],
): InspectResult {
  return InspectResultSchema.parse({
    id,
    title: repo.title,
    class: "SECURITY",
    cause: repo.title,
    effect: repo.chip,
    next: "",
    why: `${repo.status.label}; ${repo.summary}`,
    evidence: [],
    related: [
      ...repo.tabs.flatMap((tab) =>
        tab.sections.flatMap((section) =>
          section.items.map((item) => ({
            text: item.detail ? `${item.text} · ${item.detail}` : item.text,
            state: [tab.label, section.title, item.chip?.label, item.trailing]
              .filter(Boolean)
              .join(" · "),
            ...webUrl(item.href),
          })),
        ),
      ),
      ...repo.links.map((link) => ({ text: link.text, state: "On GitHub", ...webUrl(link.href) })),
    ],
    approval: null,
    actions: [],
    areas,
    provenance: [],
  });
}

export function repositoryLineResult(view: ViewSnapshot, id: string): InspectResult | undefined {
  for (const repo of view.briefing.repositories.rows) {
    for (const section of repo.sections) {
      const line = section.lines.find((line) => line.id === id);
      if (!line) continue;
      return InspectResultSchema.parse({
        id,
        title: line.text,
        class: id.startsWith("alert:") ? "SECURITY" : id.startsWith("issue:") ? "GATE" : "READY",
        cause: line.text,
        effect: line.sub,
        next: "",
        why: line.tag,
        related: [
          { text: line.text, state: section.title, ...webUrl(line.url) },
          { text: repo.name, state: "Repository", inspect: repo.id },
        ],
        evidence: [],
        approval: null,
        actions: [],
        areas: view.areas,
        provenance: [],
      });
    }
  }
  return undefined;
}
