// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type AreaEnvelope, type InspectResult, InspectResultSchema } from "@spi-code/contracts";
import { NOTES_LABEL, type ReleaseDoc } from "@spi-code/core";
import { webUrl } from "./shared.js";

export function releaseResult(doc: ReleaseDoc, areas: readonly AreaEnvelope[]): InspectResult {
  const actionText = (action: ReleaseDoc["required"][number]) =>
    [
      action.title,
      action.body,
      action.owner ? `Owner: ${action.owner}` : undefined,
      action.when ? `When: ${action.when}` : undefined,
      action.ifSkipped ? `If skipped: ${action.ifSkipped}` : undefined,
    ]
      .filter(Boolean)
      .join("; ");
  return InspectResultSchema.parse({
    id: doc.id,
    title: doc.name,
    class: doc.unread.length > 0 ? "UNREAD" : "READY",
    cause: doc.headline,
    effect: doc.stateText,
    next: doc.required.map(actionText).join("\n"),
    why: [
      NOTES_LABEL[doc.notes],
      doc.notesError,
      ...doc.stats.map((stat) => `${stat.figure} ${stat.label}`),
      ...(doc.unread.length > 0 ? [`Unread: ${doc.unread.join(", ")}`] : []),
    ]
      .filter(Boolean)
      .join("; "),
    evidence: [],
    related: [
      ...doc.keyChanges.map((text) => ({ text, state: "Key change" })),
      ...doc.highlights.map((entry) => ({
        text: [entry.title, entry.body].filter(Boolean).join(": "),
        state: "Highlight",
      })),
      ...doc.changelog.flatMap((area) =>
        area.items.map((entry) => ({ text: entry.text, state: `${area.area}: ${entry.type}` })),
      ),
      ...doc.issues.map((issue) => ({
        text: [issue.title, issue.body].filter(Boolean).join(": "),
        state: issue.state,
      })),
      ...doc.rows.map((row) => ({
        text: `${row.id}: ${row.version}`,
        state: row.state,
        ...webUrl(row.url),
      })),
      ...doc.info.map((action) => ({ text: actionText(action), state: "Info" })),
      ...doc.links.map((link) => ({
        text: link.label,
        state: "Releases",
        ...webUrl(link.url),
      })),
    ],
    approval: null,
    actions: [],
    areas,
    provenance: [],
  });
}
