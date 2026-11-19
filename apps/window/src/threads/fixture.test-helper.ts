// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ModelOption, PlaceOption, ThreadViewProps, TimelineEntry } from "./types.js";

export const FIXTURE_MODELS: ModelOption[] = [
  {
    id: "claude-sonnet-5.5",
    name: "Claude Sonnet 5.5",
    multiplier: 1,
    favourite: true,
    policy: "enabled",
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
  },
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", multiplier: 1, favourite: true, policy: "enabled" },
  {
    id: "claude-opus-5.5",
    name: "Claude Opus 5.5",
    multiplier: 3,
    policy: "enabled",
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "high",
  },
  { id: "gpt-6-mini", name: "GPT-6 mini", multiplier: 0, policy: "enabled" },
  { id: "gemini-3-pro", name: "Gemini 3 Pro", multiplier: 1, policy: "disabled" },
];

export const FIXTURE_PLACES: PlaceOption[] = [
  "Today",
  "Environment",
  "Template",
  "Upstream",
  "partition",
  "legal",
  "entitlements",
  "indexer",
  "storage",
  "search",
].map((label) => ({ id: label.toLowerCase(), label }));

/** The centre of the design's first window, without its approval row. */
export const FIXTURE_ENTRIES: TimelineEntry[] = [
  {
    kind: "setup",
    id: "s1",
    label: "Made a worktree on spi/blob-retry from the fork's main",
    status: "done",
  },
  {
    kind: "user",
    id: "u1",
    text: "Build is red on this PR. Find out why and fix it.",
    chips: ["PR #251 · Build failed"],
  },
  {
    kind: "call",
    id: "c1",
    label: "spi_inspect partition PR #251",
    status: "done",
    args: '{ "service": "partition", "pr": 251 }',
    result: "Build failed on BlobRetryTest",
  },
  {
    kind: "call",
    id: "c2",
    label: "gh run view 9812 --log-failed",
    status: "failed",
    args: "gh run view 9812 --log-failed",
    result: "exit 1: the run's logs have expired",
  },
  { kind: "call", id: "c3", label: "Read 4 files in provider/partition-azure", status: "done" },
  {
    kind: "assistant",
    id: "a1",
    text: "The retry test waits a fixed **200 ms** and the blob client's backoff now starts at `250 ms`.\n\n- The test is in the Azure provider, which the fork owns.\n- One file also needs a constant from the shared retry policy, which upstream owns.",
  },
  { kind: "call", id: "c4", label: "Edited BlobRetryTest.java", status: "done" },
  { kind: "call", id: "c5", label: "Edited RetryPolicy.java", status: "done" },
  { kind: "user", id: "u2", text: "Run the provider's tests before you stop." },
  { kind: "call", id: "c6", label: "mvn -q -pl provider/partition-azure test", status: "running" },
  {
    kind: "assistant",
    id: "a2",
    text: "Running the partition-azure tests now. The first module",
    streaming: true,
  },
];

export const noop = () => {};

export function fixtureThread(overrides: Partial<ThreadViewProps> = {}): ThreadViewProps {
  return {
    entries: FIXTURE_ENTRIES,
    contextLine: "Context · partition · from the sweep at 13:50 · 1 item, 1,300 tokens",
    scope: { id: "partition", label: "partition" },
    context: [],
    onRemoveContext: noop,
    places: FIXTURE_PLACES,
    models: FIXTURE_MODELS,
    choice: { model: "auto" },
    onChoose: noop,
    account: { login: "operator", usedPercent: 41 },
    running: true,
    draft: false,
    onSend: noop,
    onStop: noop,
    ...overrides,
  };
}

/** A long thread: alternating questions and answers, `count` rows in all. */
export function longThread(count: number): TimelineEntry[] {
  return Array.from({ length: count }, (_, i) =>
    i % 2 === 0
      ? { kind: "user", id: `u${i}`, text: `Question ${i}` }
      : { kind: "assistant", id: `a${i}`, text: `Answer ${i}` },
  );
}
