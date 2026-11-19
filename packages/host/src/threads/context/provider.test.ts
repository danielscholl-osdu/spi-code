// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { KNOWN_SERVICES } from "@spi-code/core";
import { describe, expect, it } from "vitest";
import { ScopeRegistry } from "../../scopes/registry.js";
import { offeredTools, spiReadTools } from "../../tools/spi-reads.js";
import { threadContext } from "./provider.js";
import type { ModelRedactor } from "./seams.js";

const plain: ModelRedactor = { text: (text) => text, value: (value) => value };
const tools = offeredTools(spiReadTools(() => undefined, plain));
const scopes = new ScopeRegistry();
const prepare = (scope: string, offered = tools, registry = scopes) =>
  threadContext({ scopes: registry, tools: offered, redactor: plain }).prepare({
    thread: { scope },
    message: {},
  }).instructions;

describe("scope instructions", () => {
  it("name the scope's repositories and remotes, and where its changes land", () => {
    const legal = scopes.lookup("legal");
    if (legal?.kind !== "service" || !legal.upstream) throw new Error("No legal scope");
    const service = prepare("legal");
    expect(service).toContain(`origin ${legal.origin.repo} on GitHub`);
    expect(service).toContain(`upstream ${legal.upstream.repo} on GitLab`);
    expect(service).toContain("Fork · fork_integration");
    const program = prepare("program");
    for (const scope of scopes.list()) {
      if (scope.kind !== "program") expect(program).toContain(scope.origin.repo);
    }
    expect(program).toContain("Lands in: Asking only.");
    expect(program).not.toContain("Fork · main");
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

describe("the context seam", () => {
  it("sends the chips the message snapshotted, through the model redactor", () => {
    const marked: ModelRedactor = { text: (text) => `<${text}>`, value: (value) => value };
    const context = threadContext({ scopes, tools, redactor: marked }).prepare({
      thread: { scope: "template" },
      message: { attachments: [{ name: "context:rollout", content: '{"id":"rollout"}' }] },
    });
    expect(context.attachments).toEqual([
      { name: "context:rollout", content: '<{"id":"rollout"}>' },
    ]);
  });

  it("refuses a scope it does not know", () => {
    expect(() => prepare("nope")).toThrow("No scope nope.");
  });
});
