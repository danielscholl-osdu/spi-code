// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type AreaEnvelope, type InspectResult, InspectResultSchema } from "@spi-code/contracts";
import { type CoreContext, inspectStep, type Model, stepTitle } from "@spi-code/core";
import { webUrl } from "./shared.js";

export function stepResult(
  model: Model,
  id: string,
  ctx: CoreContext,
  areas: readonly AreaEnvelope[],
): InspectResult {
  const step = inspectStep(model, id, ctx);
  return InspectResultSchema.parse({
    id,
    title: stepTitle(model, id),
    class: "ROLLOUT",
    cause: step.summary,
    effect: step.chip ?? "",
    next: "",
    why: step.status.label,
    evidence: [],
    related: [
      ...step.changes.map((change) => ({
        text: change.text,
        state: change.trailing,
        ...webUrl(change.href),
      })),
      ...step.forks.map((fork) => ({ text: fork.text, state: fork.trailing })),
      ...step.evidence.map((entry) => ({
        text: entry.text,
        state: "Evidence",
        ...webUrl(entry.href),
      })),
    ],
    approval: null,
    actions: [],
    areas,
    provenance: [],
  });
}
