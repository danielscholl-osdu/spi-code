// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stubActEnvironment } from "../test-utils/harness.js";
import { CHIP_LIMIT } from "./Composer.js";
import { FIXTURE_MODELS, fixtureThread, longThread } from "./fixture.test-helper.js";
import { ThreadView } from "./ThreadView.js";
import type { ContextChip, ThreadViewProps, ToolCall } from "./types.js";
import { ROW_BUDGET } from "./VirtualList.js";

let root: Root;
let host: HTMLDivElement;
let restoreAct: () => void;

beforeEach(() => {
  restoreAct = stubActEnvironment();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  restoreAct();
});

function render(props: ThreadViewProps) {
  act(() => root.render(<ThreadView {...props} />));
}

const all = (selector: string) => [...host.querySelectorAll<HTMLElement>(selector)];
const button = (name: string | RegExp) => {
  const found = all("button").find((b) =>
    typeof name === "string"
      ? (b.getAttribute("aria-label") ?? b.textContent) === name
      : name.test(b.getAttribute("aria-label") ?? b.textContent ?? ""),
  );
  if (!found) throw new Error(`no button ${name}`);
  return found;
};
const click = (element: HTMLElement) => act(() => element.click());

function type(text: string) {
  const area = host.querySelector("textarea");
  if (!area) throw new Error("no composer");
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(area, text);
    area.setSelectionRange(text.length, text.length);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("streams an assistant message, then settles it", () => {
  render(fixtureThread());
  const streaming = all("article[aria-busy='true']");
  expect(streaming).toHaveLength(1);
  expect(streaming[0]?.textContent).toContain("The first module");
  expect(streaming[0]?.querySelector("[role='status']")).not.toBeNull();

  const entries = fixtureThread().entries.map((entry) =>
    entry.id === "a2" && entry.kind === "assistant"
      ? { ...entry, text: `${entry.text} passed.`, streaming: false }
      : entry,
  );
  render(fixtureThread({ entries, running: false }));
  expect(all("article[aria-busy='true']")).toHaveLength(0);
  expect(host.textContent).toContain("The first module passed.");
  expect(all("[role='log'][aria-busy='true']")).toHaveLength(0);
});

it("groups three calls with one failed and opens the failed call's arguments and error", () => {
  render(fixtureThread());
  const [group] = all("section[aria-label='Work log']");
  expect(group?.querySelector(".thread-work-head")?.textContent).toBe("3 calls · 1 failed");
  const calls = all(".thread-call").slice(0, 3);
  expect(calls.map((c) => c.dataset.status)).toEqual(["done", "failed", "done"]);
  const failed = calls[1]?.querySelector("button");
  if (!failed) throw new Error("no failed call");
  expect(failed.querySelector("[aria-label='Failed']")).not.toBeNull();
  expect(failed.getAttribute("aria-expanded")).toBe("false");
  click(failed);
  expect(failed.getAttribute("aria-expanded")).toBe("true");
  expect(calls[1]?.textContent).toContain("gh run view 9812 --log-failed");
  expect(calls[1]?.textContent).toContain("exit 1: the run's logs have expired");
});

it("ends a cancelled turn with a cancelled line and offers Send again", () => {
  render(
    fixtureThread({
      running: false,
      entries: [
        { kind: "user", id: "u", text: "Run the tests." },
        { kind: "call", id: "c", label: "mvn -q test", status: "unknown" },
        { kind: "assistant", id: "a", text: "Running the" },
        { kind: "turn-end", id: "e", state: "cancelled" },
      ],
    }),
  );
  const end = host.querySelector("[data-state='cancelled']");
  expect(end?.textContent).toMatch(/^Cancelled/);
  expect(host.querySelector("[aria-label='Outcome not known']")).not.toBeNull();
  expect(all("article[aria-busy='true']")).toHaveLength(0);
  expect(() => button("Stop")).toThrow();
  expect(button(/^Send/)).toBeTruthy();
});

it("shows an edit's exact path and diff with one-shot approval controls", () => {
  const onApprovalDecision = vi.fn();
  const approval = {
    kind: "approval",
    id: "a1",
    approvalId: "a1",
    turnId: "u1",
    requestKind: "write",
    status: "pending",
    detail: "/repo/src.ts",
    path: "/repo/src.ts",
    diff: "--- a/src.ts\n+++ b/src.ts\n@@\n-old\n+new",
  } as const;
  render(fixtureThread({ entries: [approval], onApprovalDecision }));
  expect(host.querySelector(".thread-approval-path")?.textContent).toBe("/repo/src.ts");
  expect(host.querySelector(".thread-approval-diff")?.textContent).toBe(approval.diff);
  click(button("Approve once"));
  expect(onApprovalDecision).toHaveBeenCalledWith(approval, true);
  click(button("Decline"));
  expect(onApprovalDecision).toHaveBeenCalledWith(approval, false);
});

it("mounts a 2,000-row thread and an open 2,000-call group under the row budget, at its end", () => {
  render(fixtureThread({ entries: longThread(2000), running: false }));
  const rows = all(".thread-row");
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.length).toBeLessThanOrEqual(ROW_BUDGET);
  expect(host.textContent).toContain("Answer 1999");
  expect(host.textContent).not.toContain("Question 0");

  const calls = Array.from(
    { length: 2000 },
    (_, i): ToolCall => ({ kind: "call", id: `c${i}`, label: `Step ${i}`, status: "done" }),
  );
  render(fixtureThread({ entries: [...longThread(2000), ...calls], running: false }));
  expect(all(".thread-call").length).toBeGreaterThan(0);
  expect(all(".thread-row").length).toBeLessThanOrEqual(ROW_BUDGET);
  expect(all(".thread-call").length).toBeLessThanOrEqual(ROW_BUDGET);
  expect(host.textContent).toContain("Step 1999");
});

it("renders a heading split by a Unicode line separator", () => {
  render(
    fixtureThread({
      running: false,
      entries: [{ kind: "assistant", id: "a", text: "## Result\u2028All passed.\u2029- one" }],
    }),
  );
  expect(host.querySelector(".thread-md-h")?.textContent).toBe("Result");
  expect(host.querySelector(".thread-md p:not(.thread-md-h)")?.textContent).toBe("All passed.");
  expect(all(".thread-md li").map((li) => li.textContent)).toEqual(["one"]);
});

it("shows no reasoning column for a model without reasoning levels", () => {
  render(fixtureThread({ choice: { model: "gpt-6.1-sol" } }));
  click(button("Model: GPT-6.1 Sol"));
  expect(host.querySelector("[role='dialog']")).not.toBeNull();
  expect(host.querySelector("ul[aria-label='Reasoning']")).toBeNull();

  click(button("Model: GPT-6.1 Sol"));
  render(fixtureThread({ choice: { model: "claude-sonnet-5.5", effort: "high" } }));
  click(button("Model: Claude Sonnet 5.5 · High"));
  const levels = all("ul[aria-label='Reasoning'] button").map((b) => b.textContent);
  expect(levels).toEqual(["Low", "MediumDefault", "High✓"]);
});

it("refuses to choose a disabled model", () => {
  const onChoose = vi.fn();
  render(fixtureThread({ onChoose }));
  click(button("Model: Auto"));
  const gemini = button(/^Gemini 3 Pro/);
  expect(gemini.hasAttribute("disabled")).toBe(true);
  click(gemini);
  expect(onChoose).not.toHaveBeenCalled();
  click(button(/^GPT-6 mini/));
  expect(onChoose).toHaveBeenCalledWith({ model: "gpt-6-mini" });

  onChoose.mockClear();
  const refreshed = FIXTURE_MODELS.map((m) =>
    m.id === "claude-sonnet-5.5" ? { ...m, policy: "disabled" as const } : m,
  );
  render(
    fixtureThread({
      onChoose,
      models: refreshed,
      choice: { model: "claude-sonnet-5.5", effort: "high" },
    }),
  );
  click(button("Model: Claude Sonnet 5.5 · High"));
  const low = button(/^Low/);
  expect(low.hasAttribute("disabled")).toBe(true);
  click(low);
  expect(onChoose).not.toHaveBeenCalled();
});

it("lists places after @ and adds the chosen one as a chip", () => {
  const onSend = vi.fn();
  render(fixtureThread({ onSend, running: false }));
  type("Compare with @par");
  const menu = host.querySelector("ul[aria-label='Places']");
  expect([...(menu?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual([
    "partition",
  ]);
  click(button("partition"));
  expect(host.querySelector("ul[aria-label='Places']")).toBeNull();
  expect(host.querySelector("textarea")?.value).toBe("Compare with ");
  expect(button("Remove partition")).toBeTruthy();
  type("Compare with ");
  click(button(/^Send/));
  expect(onSend).toHaveBeenCalledWith({
    text: "Compare with",
    places: [{ id: "partition", label: "partition" }],
  });
});

it("refuses a ninth chip and says why", () => {
  const context: ContextChip[] = Array.from({ length: CHIP_LIMIT }, (_, i) => ({
    id: `chip${i}`,
    label: `Item ${i}`,
    preview: `item ${i}`,
  }));
  const onSend = vi.fn();
  render(fixtureThread({ context, onSend, running: false }));
  type("Also @leg");
  click(button("legal"));
  expect(host.querySelector(".thread-composer [role='status']")?.textContent).toBe(
    "A message carries at most 8 context chips. Remove one to add another.",
  );
  expect(() => button("Remove legal")).toThrow();
  click(button(/^Send/));
  expect(onSend).toHaveBeenCalledWith({ text: "Also @leg", places: [] });

  render(fixtureThread({ context: context.slice(1), onSend, running: false }));
  type("Also @par");
  const menu = host.querySelector("ul[aria-label='Places']");
  expect([...(menu?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual([
    "partition",
  ]);
});
