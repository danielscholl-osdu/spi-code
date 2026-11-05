// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Envelope, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import briefing from "../../../../../fixtures/rib-59d6895/oracle/briefing.json?raw";
import releases from "../../../../../fixtures/rib-59d6895/oracle/releases.json?raw";
import { testSnapshot } from "../../store/test-snapshot.js";
import { watchStore } from "../../store/watch.js";
import Releases from "./index.js";

const container = document.createElement("div");
let root: ReturnType<typeof createRoot> | undefined;
const previous = watchStore.getState();

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  watchStore.setState(previous);
});

it.each([
  { reading: true, state: "stale" },
  { reading: false, state: "failed" },
] as const)(
  "shows a $state release envelope with no lines while reading=$reading",
  async ({ reading, state }) => {
    const base = testSnapshot(briefing, releases);
    const envelope = {
      source: "releases",
      state,
      observedAt: base.sweptAt,
      completeness: { kind: "complete" },
      inferred: true,
    } satisfies Envelope;
    const body = testSnapshot(briefing, releases, {
      releases: { lines: [], reading },
      provenance: [{ path: "/releases", areas: ["fleet"], envelope }],
    });
    watchStore.setState({ snapshot: { cursor: body.cursor, body } });
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<Releases />));
    const badge = container.querySelector("[data-release-envelopes] [data-envelope]");
    expect(badge?.getAttribute("data-envelope")).toBe(state);
    expect(badge?.querySelector("[data-inferred]")).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      reading ? "Reading releases…" : "No releases read yet.",
    );
    expect(container.querySelector("[data-rel]")).toBeNull();
  },
);

it("finds release evidence beyond the first line and retains it when the lines become empty", async () => {
  const base = testSnapshot(briefing, releases);
  const envelope = {
    source: "releases",
    state: "failed",
    completeness: { kind: "complete" },
  } satisfies Envelope;
  const body = testSnapshot(briefing, releases, {
    provenance: [{ path: "/releases/lines/1", areas: ["fleet"], envelope }],
  });
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<Releases />));
  const badge = () => container.querySelector("[data-release-envelopes] [data-envelope]");
  expect(badge()?.getAttribute("data-envelope")).toBe("failed");
  const empty = ViewSnapshotSchema.parse({
    ...base,
    cursor: 2,
    releases: { lines: [], reading: false },
    provenance: [{ path: "/releases/lines", areas: ["fleet"], envelope }],
  });
  await act(async () => watchStore.setState({ snapshot: { cursor: 2, body: empty } }));
  expect(badge()?.getAttribute("data-envelope")).toBe("failed");
  expect(container.querySelector("[data-rel]")).toBeNull();
});

it.each([true, false])(
  "preserves inferred=%s on legacy release values without a supplemental envelope",
  async (inferred) => {
    const base = testSnapshot(briefing, releases);
    const body = testSnapshot(briefing, releases, {
      releases: { ...base.releases, lines: base.releases.lines.slice(0, 1) },
      areas: base.areas.map((entry) =>
        entry.area === "fleet"
          ? {
              area: "fleet",
              envelope: {
                source: "fleet",
                state: "fresh",
                observedAt: base.sweptAt,
                completeness: { kind: "complete" },
                inferred,
              },
            }
          : entry,
      ),
      provenance: [{ path: "/releases/lines/0", areas: ["fleet"] }],
    });
    watchStore.setState({ snapshot: { cursor: body.cursor, body } });
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<Releases />));
    const drawn = container.querySelectorAll('[data-pointer="/releases/lines/0"]');
    expect(drawn).toHaveLength(2);
    for (const element of drawn) {
      expect(element.querySelectorAll("[data-inferred]")).toHaveLength(inferred ? 1 : 0);
    }
    expect(container.querySelector("[data-release-envelopes]")).toBeNull();
  },
);
