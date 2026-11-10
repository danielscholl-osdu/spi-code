// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import {
  AREAS,
  type AreaEnvelope,
  type Envelope,
  type ReadRecord,
  type SweepProgress,
  SweepProgressSchema,
  ViewSnapshotSchema,
} from "@spi-code/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SweepSection } from "../../settings/SweepSection.js";
import { createWatchStore, type Snapshot } from "../../store/watch.js";
import { clockTime, timeUnit } from "../../time.js";
import { sweepStatus } from "../sweep/test-helper.js";
import { SweepEvidence } from "./EvidenceTab.js";
import { SweepLine, type SweepLineSnapshot } from "./SweepLine.js";

/** The host's second sweep, 14 h after the first, as packages/host's release-freshness test records it. */
const recorded = JSON.parse(
  readFileSync("apps/window/src/components/evidence/fixtures/release-reread.json", "utf8"),
) as { now: string; snapshot: { sweptAt: string; provenance: unknown; reads: ReadRecord[] } };
const HOUR = 3_600_000;
const read = Date.parse(recorded.now);
const now = read + 3_000;

type Body = SweepLineSnapshot & { reads: readonly ReadRecord[] };

function sweep(): { body: Body; progress: SweepProgress } {
  const { sweptAt, provenance, reads } = recorded.snapshot;
  const areas: AreaEnvelope[] = AREAS.map((area) => ({
    area,
    envelope: {
      source: area,
      state: "fresh",
      observedAt: sweptAt,
      completeness: { kind: "complete" },
    },
  }));
  return {
    body: {
      sweptAt,
      briefing: { nextSyncAt: new Date(read + 5 * HOUR).toISOString() },
      areas,
      provenance: ViewSnapshotSchema.shape.provenance.parse(provenance),
      reads,
    },
    progress: SweepProgressSchema.parse((recorded as unknown as { progress: unknown }).progress),
  };
}

/** Release lines skipped as not due, their last read `hours` before this sweep and now stale. */
function notDue(hours: number): { body: Body; progress: SweepProgress } {
  const { body, progress } = sweep();
  const observedAt = new Date(read - hours * HOUR).toISOString();
  return {
    body: {
      ...body,
      provenance: body.provenance.map((entry) => ({
        ...entry,
        envelope: { ...entry.envelope, state: "stale", observedAt } as Envelope,
      })),
    },
    progress: {
      ...progress,
      sources: progress.sources.map((source) => ({
        source: source.source,
        state: "skipped",
        endedAt: recorded.now,
        code: "cadence",
        reason: "not due",
      })),
    },
  };
}

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

/** Release lines as Evidence, the top row's sweep line and Settings → Sweep show them. */
async function shown({ body, progress }: { body: Body; progress: SweepProgress }) {
  const store = createWatchStore(() => {});
  store.setState({
    snapshot: { cursor: 1, body: body as unknown as Snapshot["body"] },
    sweep: sweepStatus({ nextSweepAt: null, resetAt: null }),
    progress: null,
    completed: progress,
  });
  const view = await render(
    <>
      <SweepEvidence snapshot={body} sweep={null} completed={progress} now={now} />
      <SweepLine snapshot={body} onOpen={() => {}} />
      <SweepSection store={store} />
    </>,
  );
  const { container } = view;
  const row = container.querySelector('.sweep-row[data-source="releases"]');
  const settings = [...container.querySelectorAll(".sweep-reads tbody tr")].find(
    (tr) => tr.querySelector("td")?.textContent === "Release lines",
  );
  const result = {
    evidence: [row?.getAttribute("data-tone"), row?.querySelector(".sweep-outcome")?.textContent],
    line: container.querySelector('[data-evidence="sweep"] .evidence-line')?.textContent,
    header: container.querySelector("[data-sweep-line]")?.textContent,
    settings: [...(settings?.querySelectorAll("td") ?? [])].map((td) => td.textContent),
  };
  await view.cleanup();
  return result;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("shows Release lines read by this sweep as read just now in Evidence, the header and Settings", async () => {
  const view = await shown(sweep());
  expect(view.evidence).toEqual(["ok", "read · 0\u00a0s · last read just now"]);
  expect(view.line).toBe(`swept just now · all fresh · next sync in ${timeUnit(5, "h")}`);
  expect(view.header).toContain("all areas read");
  expect(view.settings).toEqual([
    "Release lines",
    "every hour",
    `last read ${clockTime(recorded.now, { now, hint: false })}`,
  ]);
});

it("still calls Release lines stale when a sweep skips them and their last read is over two hours old", async () => {
  const view = await shown(notDue(14));
  expect(view.evidence).toEqual([
    "warn",
    expect.stringMatching(/^skipped · stale, last read 14\u00a0h ago$/),
  ]);
  expect(view.line).toContain("release lines stale");
  expect(view.header).toContain("1 stale");
  expect(view.settings).toEqual([
    "Release lines",
    "every hour",
    `last read ${clockTime(new Date(read - 14 * HOUR).toISOString(), { now, hint: false })}`,
  ]);
});
