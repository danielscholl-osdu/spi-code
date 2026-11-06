// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Envelope, ReadRecord } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { Derived, EnvelopeBadge, ReadList } from "./index.js";
import { worstEnvelope } from "./WorstEnvelope.js";

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const at = "2026-11-05T10:00:00Z";
const complete = { kind: "complete" } as const;
const cut = { kind: "cut", reason: "rate limit", read: 40, total: 52 } as const;
const envelopes: Record<string, Envelope> = {
  fresh: { source: "github", state: "fresh", observedAt: at, completeness: complete },
  stale: { source: "github", state: "stale", observedAt: at, completeness: complete },
  incomplete: { source: "github", state: "incomplete", observedAt: at, completeness: cut },
  failed: { source: "Actions", state: "failed", completeness: complete },
  unread: { source: "GitLab", state: "unread" },
};

it.each([
  ["fresh", "fresh · 2 min", "fresh"],
  ["stale", "stale · 2 min", "stale"],
  ["incomplete", "incomplete · 40 of 52", "stale"],
  ["failed", "read failed · Actions", "bad"],
  ["unread", "unread · GitLab", "muted"],
])("badge for %s shows its text and tone", async (name, text, tone) => {
  const { container, cleanup } = await render(
    <EnvelopeBadge envelope={envelopes[name] as Envelope} now={Date.parse(at) + 120_000} />,
  );
  try {
    const chip = container.querySelector("[data-tone]");
    expect(chip?.textContent).toBe(text);
    expect(chip?.getAttribute("data-tone")).toBe(tone);
    expect(container.querySelector("[data-inferred]")).toBeNull();
  } finally {
    await cleanup();
  }
});

it("badge marks an inferred envelope", async () => {
  const { container, cleanup } = await render(
    <EnvelopeBadge envelope={{ ...(envelopes.fresh as Envelope), inferred: true } as Envelope} />,
  );
  try {
    expect(container.querySelector("[data-inferred]")?.textContent).toBe("inferred");
  } finally {
    await cleanup();
  }
});

it("Derived renders the marker in the same row only for an inferred record", async () => {
  const record: ReadRecord = {
    source: "gitlab",
    object: "mr",
    observedAt: at,
    completeness: complete,
  };
  const { container, cleanup } = await render(
    <p>
      <Derived record={{ ...record, inferred: true }}>deployable</Derived>
      <Derived record={record}>healthy</Derived>
      <Derived>plain</Derived>
    </p>,
  );
  try {
    const rows = container.querySelectorAll("p > span");
    expect(rows[0]?.textContent).toBe("deployableinferred");
    expect(rows[0]?.querySelector("[data-inferred]")).not.toBeNull();
    expect(rows[1]?.textContent).toBe("healthy");
    expect(rows[2]?.textContent).toBe("plain");
    expect(container.querySelectorAll("[data-inferred]")).toHaveLength(1);
  } finally {
    await cleanup();
  }
});

it("ReadList shows observedAt per record and retainedFrom for a retained read", async () => {
  const records: ReadRecord[] = [
    { source: "github", object: "runs", observedAt: at, completeness: complete },
    {
      source: "github",
      object: "alerts",
      observedAt: "2026-11-05T11:00:00Z",
      completeness: cut,
      failure: "timeout",
      retainedFrom: "2026-11-05T08:00:00Z",
    },
  ];
  const { container, cleanup } = await render(<ReadList records={records} />);
  try {
    const rows = container.querySelectorAll("li");
    expect(rows[0]?.textContent).toContain(`observed ${at}`);
    expect(rows[0]?.textContent).not.toContain("retained from");
    expect(rows[1]?.textContent).toContain("observed 2026-11-05T11:00:00Z");
    expect(rows[1]?.textContent).toContain("retained from 2026-11-05T08:00:00Z");
    expect(rows[1]?.textContent).toContain("failed: timeout");
  } finally {
    await cleanup();
  }
});

it("worstEnvelope orders failed > unread > incomplete > stale > fresh, empty is unread", () => {
  const order = ["failed", "unread", "incomplete", "stale", "fresh"];
  for (let i = 0; i < order.length; i++) {
    const rest = order.slice(i).map((name) => envelopes[name] as Envelope);
    expect(worstEnvelope([...rest].reverse()).state).toBe(order[i]);
  }
  expect(worstEnvelope([]).state).toBe("unread");
  const inferred = { ...(envelopes.stale as Envelope), source: "b", inferred: true } as Envelope;
  expect(worstEnvelope([envelopes.stale as Envelope, inferred])).toBe(inferred);
});
