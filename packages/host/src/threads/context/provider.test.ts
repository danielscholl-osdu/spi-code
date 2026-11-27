// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { KNOWN_SERVICES } from "@spi-code/core";
import type { ToolOutputRedactor } from "@spi-code/threads";
import { describe, expect, it } from "vitest";
import { ScopeRegistry } from "../../scopes/registry.js";
import { spiGuideTool } from "../../tools/spi-guide.js";
import { offeredTools, spiReadTools } from "../../tools/spi-reads.js";
import { allGuides, guidesFor, programRules, type ScopeKind } from "./knowledge.js";
import { threadContext } from "./provider.js";

const plain: Pick<ToolOutputRedactor, "text" | "value"> = {
  text: (text) => text,
  value: (value) => value,
};
const reads = offeredTools(spiReadTools(() => undefined, plain));
const tools = [...reads, ...offeredTools([spiGuideTool()])];
const INSTRUCTION_BYTE_BUDGET = 9_000;
const scopes = new ScopeRegistry();
const prepare = (scope: string, offered = tools, registry = scopes) =>
  threadContext({ scopes: registry, tools: offered, redactor: plain }).prepare({
    thread: { scope },
    message: { prompt: "Question" },
  }).instructions;

describe("scope instructions", () => {
  it("name the scope's repositories and remotes, and where its changes land", () => {
    const legal = scopes.lookup("legal");
    if (legal?.kind !== "service" || !legal.upstream) throw new Error("No legal scope");
    const service = prepare("legal");
    expect(service).toContain(`origin ${legal.origin.repo} on GitHub`);
    expect(service).toContain(`upstream ${legal.upstream.repo} on GitLab`);
    expect(service).toContain("Fork · fork_integration");
    expect(service).toContain("File ownership follows .github/upstream-filter.yml");
    expect(service).toContain("unlisted entries are unknown");
    const program = prepare("program");
    for (const scope of scopes.list()) {
      if (scope.kind !== "program") expect(program).toContain(scope.origin.repo);
    }
    expect(program).toContain("Lands in: Asking only.");
    expect(program).not.toContain("Fork · main");
    expect(program).not.toContain("File ownership follows");
    expect(program).toContain("no edit or command is offered in a program thread");
    expect(service).toContain("once it lands in a worktree you edit files and run commands");
  });

  it("list exactly the SPI tools offered, and the fleet they are given", () => {
    for (const { name } of tools) expect(prepare("program")).toContain(`- ${name}: `);
    expect(prepare("program", [])).not.toMatch(/spi_\w+/);
    const [first, second] = KNOWN_SERVICES;
    if (!first || !second) throw new Error("No services");
    const narrowed = prepare("program", tools, new ScopeRegistry([first]));
    expect(narrowed).toContain(scopes.lookup(first.id)?.title ?? first.id);
    const retired = scopes.lookup(second.id);
    expect(retired?.kind === "service" && narrowed.includes(retired.origin.repo)).toBe(false);
  });
});

describe("program knowledge", () => {
  const KINDS: readonly [ScopeKind, string][] = [
    ["program", "program"],
    ["service", "legal"],
    ["template", "template"],
    ["environment", "environment"],
  ];
  // A rule written for some kinds only, keyed by the first kind that has it.
  const own = (kind: ScopeKind) =>
    programRules(kind).filter((rule) => !programRules("program").includes(rule));

  it.each(KINDS)("a %s thread carries its rules and no other kind's", (kind, scope) => {
    const text = prepare(scope);
    for (const rule of programRules(kind)) expect(text).toContain(`- ${rule}`);
    for (const [other] of KINDS) {
      for (const rule of own(other)) {
        if (!programRules(kind).includes(rule)) expect(text).not.toContain(rule);
      }
    }
  });

  it("sends a rule written for one kind of scope to that kind alone", () => {
    const only: Record<Exclude<ScopeKind, "program">, string> = {
      service: "The root pom and the shared modules are upstream's.",
      template: "Never patch one fork by hand to get a template change green.",
      environment: "The stack repository merges by squash only",
    };
    for (const [kind, scope] of KINDS) {
      for (const [owner, rule] of Object.entries(only)) {
        expect(prepare(scope).includes(rule)).toBe(owner === kind);
      }
    }
  });

  it("gives each scoped kind a rule of its own beside the ones every thread gets", () => {
    expect(programRules("program").length).toBeGreaterThan(0);
    for (const kind of ["service", "template", "environment"] as const) {
      expect(own(kind).length).toBeGreaterThan(0);
    }
  });

  it.each(KINDS)("a %s thread lists its guides by id, never their steps", (kind, scope) => {
    const text = prepare(scope);
    const listed = guidesFor(kind);
    expect(listed.length).toBeGreaterThan(0);
    for (const guide of allGuides()) {
      const line = `- ${guide.id}: when ${guide.when}.`;
      if (listed.includes(guide)) expect(text).toContain(line);
      else expect(text).not.toContain(line);
      expect(text).not.toContain(guide.steps);
      expect(text).not.toContain(guide.steps.split("\n\n")[0]);
    }
  });

  it("names no guide when the tool that reads one is not offered", () => {
    for (const [, scope] of KINDS) {
      const text = prepare(scope, reads);
      expect(text).not.toContain("Guides hold the steps");
      for (const guide of allGuides()) expect(text).not.toContain(`- ${guide.id}: when `);
      expect(text).toContain("Program rules, learned running this program:");
    }
  });

  it.each(KINDS)("keeps a %s thread's instructions inside the budget", (_kind, scope) => {
    expect(Buffer.byteLength(prepare(scope))).toBeLessThanOrEqual(INSTRUCTION_BYTE_BUDGET);
  });
});

describe("the context seam", () => {
  it("sends the chips the message snapshotted, names included, through the model redactor", () => {
    const fake = ["gh", "p_", "FAKE".repeat(9)].join("");
    const masking: Pick<ToolOutputRedactor, "text"> = {
      text: (text) => `<${text.replaceAll(fake, "[redacted]")}>`,
    };
    const context = threadContext({ scopes, tools, redactor: masking }).prepare({
      thread: { scope: "template" },
      message: {
        prompt: "Question",
        attachments: [{ name: `context:pr:${fake}`, content: '{"id":"rollout"}' }],
      },
    });
    expect(context.attachments).toEqual([
      { name: "<context:pr:[redacted]>", content: '<{"id":"rollout"}>' },
    ]);
  });

  it("refuses a scope it does not know", () => {
    expect(() => prepare("nope")).toThrow("No scope nope.");
  });
});
