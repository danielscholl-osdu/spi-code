// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import { watchStore } from "../../store/watch.js";
import { fixtureLoader } from "../../test-utils/harness.js";
import { StatusCapsule } from "./StatusCapsule.js";

const previous = watchStore.getState();
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  watchStore.setState(previous, true);
  vi.useRealTimers();
});

it.each([
  ["exactly two hours", 7_200_000, true],
  ["inside two hours", 6_000_000, true],
  ["outside two hours", 7_200_001, false],
  ["past", -1, false],
  ["now", 0, false],
  ["unknown", undefined, false],
  ["invalid", Number.NaN, false],
] as const)("shows sync only when near and known: %s", async (_name, delta, present) => {
  vi.useFakeTimers();
  const now = Date.parse("2026-11-06T15:00:00Z");
  vi.setSystemTime(now);
  const body = fixtureLoader(readFixture)("snapshot-1106.json");
  body.briefing.nextSyncAt =
    delta === undefined
      ? undefined
      : Number.isNaN(delta)
        ? "unknown"
        : new Date(now + delta).toISOString();
  watchStore.setState({ snapshot: { cursor: body.cursor, body }, progress: null });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  await act(async () => root.render(<StatusCapsule />));
  expect(container.querySelector("[data-field=next-sync]") !== null).toBe(present);
  if (present && delta !== undefined) {
    await act(async () => vi.advanceTimersByTimeAsync(delta));
    expect(container.querySelector("[data-field=next-sync]")).toBeNull();
  }
});
