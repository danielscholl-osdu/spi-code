// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type SecurityPane,
  type SecurityRuleRow,
  SecurityRuleRowSchema,
  type SecurityWhere,
  ViewSnapshotSchema,
} from "@spi-code/contracts";
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { readFixture } from "../../../../../../scripts/watch-generated.mjs";
import { watchStore } from "../../../store/watch.js";
import { stubActEnvironment } from "../../../test-utils/harness.js";
import { watchFixtureText } from "../../../test-utils/watch-fixtures.test-helper.js";
import { type ThreadSummary, threadStore } from "../../../threads/store.js";
import { OpenedRule, ruleTarget } from "./OpenedRule.js";
import { RULE_ATTR, useSecurityState } from "./state.js";

const KEY = "spi:code:CodeQL:java/spring-disabled-csrf-protection";
const snapshot = ViewSnapshotSchema.parse(
  JSON.parse(watchFixtureText("snapshot-59d6895.json", readFixture)),
);
const pane = snapshot.security as SecurityPane;

const line = (repository: string, read = true): SecurityWhere => ({
  repository,
  first: true,
  read,
  count: read ? [{ n: 1, atLeast: false }] : [],
  files: [read ? { code: "src/main/Config.java" } : "Code scanning alerts not read"],
  needs: [],
  alerts: read
    ? [
        {
          label: "CodeQL #3",
          url: `https://github.com/example-org/${repository}/security/code-scanning/3`,
          heavy: true,
          name: `${repository}: CodeQL #3, high, src/main/Config.java`,
        },
      ]
    : [],
  prs: [],
});

const rule: SecurityRuleRow = SecurityRuleRowSchema.parse({
  key: KEY,
  list: "code",
  severity: "High",
  title: "Disabled Spring CSRF protection",
  sub: [],
  ticks: [],
  spread: [],
  strip: [],
  alerts: { n: 2, atLeast: true },
  high: 2,
  fix: [],
  age: [],
  prs: [],
  repositories: ["partition", "legal"],
  opened: {
    facts: [],
    where: [line("partition"), line("legal"), line("workflow", false)],
    also: [],
  },
});

function Harness({ rule }: { rule: SecurityRuleRow }) {
  const root = useRef<HTMLElement>(null);
  const { state, actions } = useSecurityState(root);
  const lane = pane.lanes[0];
  return (
    <section ref={root}>
      <button type="button" data-tick onClick={() => actions.openRule(KEY, "workflow")}>
        workflow tick
      </button>
      <div {...{ [RULE_ATTR]: KEY }}>
        {lane && state.rule === KEY && (
          <OpenedRule pane={pane} lane={lane} state={state} actions={actions} rule={rule} />
        )}
      </div>
    </section>
  );
}

const cleanups: (() => Promise<void>)[] = [];

let restoreAct: () => void;
beforeAll(() => {
  restoreAct = stubActEnvironment();
});
afterAll(() => restoreAct());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function render(opened: SecurityRuleRow) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Harness rule={opened} />));
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return container;
}

it("marks the repository a tick or block arrived from and moves focus to its line", async () => {
  const container = await render(rule);
  await act(async () => container.querySelector<HTMLButtonElement>("[data-tick]")?.click());
  const lines = [...container.querySelectorAll<HTMLElement>(".security-where-line")];
  expect(lines.map((el) => el.hasAttribute("data-marked"))).toEqual([false, false, true]);
  expect(document.activeElement).toBe(lines[2]);
  expect(lines[2]?.querySelector(".security-evidence")).not.toBeNull();
  expect(lines[0]?.querySelector("a")?.getAttribute("aria-label")).toBe(
    "partition: CodeQL #3, high, src/main/Config.java",
  );
});

const OTHER = "spi:dep:org.example:widget";
const owned = (subject: string, status: ThreadSummary["status"]): ThreadSummary => ({
  id: `thread-${status}`,
  thread: { scope: "partition", title: "Why CSRF is off", subject },
  status,
  sequence: 1,
  updatedAt: 1,
  settledAt: status === "Settled" ? 1 : null,
  done: status === "Settled",
});

async function opened(at: SecurityRuleRow, threads: ThreadSummary[] = []) {
  const previous = watchStore.getState().snapshot;
  const before = threadStore.getState().threads;
  watchStore.setState({ snapshot: { cursor: 1, body: snapshot } });
  threadStore.setState({ threads });
  cleanups.push(async () => {
    watchStore.setState({ snapshot: previous });
    threadStore.setState({ threads: before });
  });
  const container = await render(at);
  await act(async () => container.querySelector<HTMLButtonElement>("[data-tick]")?.click());
  return container;
}

const single = { ...rule, opened: { ...rule.opened, ask: { fork: "partition" } } };

it("offers Ask about this on a rule in one fork, under its own subject, and none without a fork", async () => {
  expect(ruleTarget(single)).toEqual({
    subject: `security-rule:${KEY}`,
    label: "Disabled Spring CSRF protection",
    scope: "partition",
    origin: "Started from Security › Disabled Spring CSRF protection",
  });
  const offered = await opened(single);
  expect(offered.querySelector(".security-opened-acts .ask-about")?.textContent).toBe(
    "✦Ask about this",
  );
  const none = await opened(rule);
  expect(none.querySelector(".ask-about")).toBeNull();
});

it("shows a thread as the owner of its own rule only, settled or not", async () => {
  for (const status of ["Working", "Settled"] as const) {
    const threads = [owned(`security-rule:${KEY}`, status)];
    const own = await opened(single, threads);
    expect(own.querySelector(".ask-about--owned")?.textContent).toBe(
      `✦Why CSRF is off · ${status}`,
    );
    const other = { ...single, key: OTHER, title: "org.example:widget" };
    const elsewhere = await opened(other, threads);
    expect(elsewhere.querySelector(".ask-about--owned")).toBeNull();
    expect(elsewhere.querySelector(".ask-about")?.textContent).toBe("✦Ask about this");
  }
});

it("gives ⌘N the opened rule while it is open, whether or not it offers Ask", async () => {
  threadStore.getState().setTarget(null);
  const container = await render(rule);
  expect(threadStore.getState().target).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>("[data-tick]")?.click());
  expect(threadStore.getState().target).toEqual(ruleTarget(rule));
  for (const cleanup of cleanups.splice(0)) await cleanup();
  expect(threadStore.getState().target).toBeNull();
});
