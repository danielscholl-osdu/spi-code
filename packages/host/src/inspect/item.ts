// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type AreaEnvelope,
  type InspectResult,
  InspectResultSchema,
  type ReadRecord,
} from "@spi-code/contracts";
import {
  approvalSection,
  type CoreContext,
  checkable,
  type Exec,
  entryAcrossForks,
  Gh,
  Glab,
  type InspectOptions,
  inspectItem,
  inspectTitle,
  type Model,
  type QueueItem,
  verbsOf,
} from "@spi-code/core";
import { appActions } from "../watch/project.js";
import { readRecord, webUrl } from "./shared.js";

/**
 * Core inspection mapped to the contract, with the FILTERS read for a checkable halt. Areas are
 * the sweep's stored envelopes. Provenance is empty: no value is bound to a source until core
 * records which reads produced it, so the window shows none as inferred.
 */
export async function inspectResult(
  model: Model,
  item: QueueItem,
  now: Date,
  ctx: CoreContext,
  exec: Exec,
  areas: readonly AreaEnvelope[],
  opts: InspectOptions = {},
): Promise<InspectResult> {
  const entries = checkable(item.halt)
    ? await entryAcrossForks(new Gh(exec), new Glab(exec), item.halt, ctx)
    : undefined;
  const inspection = inspectItem(
    model,
    item,
    now,
    ctx,
    entries ? { others: { id: item.id, entries } } : {},
  );
  const approvals = approvalSection(item, model, opts);
  const evidence = new Map<string, ReadRecord>();
  for (const record of (entries ?? []).flatMap((entry) => entry.attempted)) {
    const parsed = readRecord(record);
    evidence.set(JSON.stringify(parsed), parsed);
  }
  return InspectResultSchema.parse({
    id: item.id,
    title: inspectTitle(item),
    class: inspection.class,
    cause: inspection.cause,
    effect: inspection.effect,
    next: inspection.next,
    why: inspection.why.map((field) => `${field.label}: ${field.value}`).join("; "),
    evidence: [...evidence.values()],
    related: [
      ...inspection.related.map((r) => ({
        text: r.text,
        state: r.state,
        ...(r.inspect ? { inspect: r.inspect } : webUrl(r.url)),
      })),
      ...inspection.evidence.map((field) => ({
        text: field.value,
        state: field.label,
        ...webUrl(field.href),
      })),
      ...(inspection.sameEntry?.rows ?? []).map((row) => ({
        text: row.trailing ? `${row.text} · ${row.trailing}` : row.text,
        state: row.chip?.label ?? "",
        ...webUrl(row.href),
      })),
    ],
    approval: approvals ? { id: item.id, state: "pending", reason: approvals.title } : null,
    actions: appActions([
      ...verbsOf(item, model, ctx, opts),
      ...(approvals?.items.flatMap((entry) => entry.actions) ?? []),
    ]),
    areas,
    provenance: [],
  });
}
