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
import { afterEach, expect, it } from "vitest";
import { readFixture } from "../../../../../../scripts/watch-generated.mjs";
import { watchFixtureText } from "../../../test-utils/watch-fixtures.test-helper.js";
import { OpenedRule } from "./OpenedRule.js";
import { RULE_ATTR, useSecurityState } from "./state.js";

const KEY = "spi:code:CodeQL:java/spring-disabled-csrf-protection";
const pane = ViewSnapshotSchema.parse(
  JSON.parse(watchFixtureText("snapshot-59d6895.json", readFixture)),
).security as SecurityPane;

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

function Harness() {
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
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it("marks the repository a tick or block arrived from and moves focus to its line", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Harness />));
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => container.querySelector<HTMLButtonElement>("[data-tick]")?.click());
  const lines = [...container.querySelectorAll<HTMLElement>(".security-where-line")];
  expect(lines.map((el) => el.hasAttribute("data-marked"))).toEqual([false, false, true]);
  expect(document.activeElement).toBe(lines[2]);
  expect(lines[2]?.querySelector(".security-evidence")).not.toBeNull();
  expect(lines[0]?.querySelector("a")?.getAttribute("aria-label")).toBe(
    "partition: CodeQL #3, high, src/main/Config.java",
  );
});
