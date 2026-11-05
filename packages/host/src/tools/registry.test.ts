// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import type { PermissionRequest } from "@github/copilot-sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FakeSession } from "../testing/fake-session.js";
import { buildPermissionGate, buildSessionToolFilter } from "./permission-gate.js";
import { buildGatedTool, createStubSessionConfig } from "./registry.js";
import { APPENDIX_A_TOOLS, GATED_KINDS, type ToolTier } from "./tool-names.js";

const prd = readFileSync(new URL("../../../../design/spi-code-prd.md", import.meta.url), "utf8");
const appendix = prd.split("### Appendix A:")[1]?.split("### Appendix B:")[0] ?? "";
const rows = appendix.split("\n").filter((line) => line.startsWith("| **"));
const expected = rows
  .filter((row) => !row.startsWith("| **Not offered**"))
  .flatMap((row) => {
    const [tier, tools] = row.split("|").slice(1, 3);
    return [...(tools ?? "").matchAll(/`([^`]+)`/g)].map((match) => ({
      name: match[1],
      tier: tier?.trim().replaceAll("*", ""),
    }));
  });
const allow = () => ({ allowed: true as const });
const invocation = { sessionId: "fake", toolCallId: "call", toolName: "probe", arguments: {} };

describe("appendix A session boundary", () => {
  it("offers every appendix name exactly once, at its tier, preloaded and custom-only", async () => {
    const config = createStubSessionConfig(allow);
    const unique = [...new Map(expected.map((tool) => [tool.name, tool])).values()];
    expect(unique.length).toBeGreaterThan(40);
    expect(config.tools.map(({ name, tier }) => ({ name, tier }))).toEqual(unique);
    expect(new Set(config.tools.map((tool) => tool.name)).size).toBe(config.tools.length);
    expect(config.availableTools).toEqual(unique.map(({ name }) => `custom:${name}`));
    const session = new FakeSession(config);
    for (const tool of config.tools) {
      expect(tool.defer).toBe("never");
      expect(tool.skipPermission).toBe(true);
      expect(await session.callTool(tool.name, {})).toBe(`ships at ${tool.milestone}`);
    }
  });

  it("does not register any Not offered command or variant", async () => {
    const config = createStubSessionConfig(allow);
    const session = new FakeSession(config);
    const forbidden = rows.find((row) => row.startsWith("| **Not offered**")) ?? "";
    expect(forbidden).toContain("any guard bypass");
    const names = [
      ...[...forbidden.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? ""),
      "merge_cascade_pr",
      "approve_review",
      "squash_merge",
      "force_push",
      "repository_secrets",
      "k8s_secrets",
      "guard_bypass",
    ];
    for (const name of names) {
      expect(config.tools.some((tool) => tool.name === name)).toBe(false);
      await expect(session.callTool(name, {})).rejects.toThrow("not available");
    }
    for (const [name, args] of [
      ["stack_reconcile", { variant: "suspend" }],
      ["k8s_get", { resource: "secrets" }],
      ["merge_pr", { kind: "cascade" }],
      ["run_command", { command: "git push" }],
    ] as const) {
      await expect(session.callTool(name, args)).rejects.toThrow("arguments refused");
    }
  });

  it("labels the stubs with their PRD shipping milestone", () => {
    const m6 = new Set([
      "mr_diff",
      "stack_status",
      "stack_info",
      "flux_state",
      "pod_logs",
      "k8s_get",
      "az_show",
      "open_upstream_mr",
      "dispatch_env_reset",
      "stack_reconcile",
      "maintenance_set",
      "maintenance_clear",
      "service_pin",
      "service_reset",
    ]);
    for (const tool of APPENDIX_A_TOOLS) {
      const milestone = m6.has(tool.name)
        ? "M6"
        : tool.tier === "Local" || tool.tier === "Command" || tool.name === "push_branch"
          ? "M5"
          : tool.tier === "Read"
            ? "M3"
            : "M4";
      expect(tool.milestone, tool.name).toBe(milestone);
    }
  });

  it("cannot reach a registered tool missing from availableTools", async () => {
    const effect = vi.fn();
    const tool = buildGatedTool(
      { name: "hidden", tier: "Read", milestone: "M3" },
      z.strictObject({}),
      allow,
      effect,
    );
    const session = new FakeSession({
      tools: [tool],
      availableTools: [],
      onPermissionRequest: buildPermissionGate(),
    });
    await expect(session.callTool("hidden", {})).rejects.toThrow("not available");
    await expect(session.callTool("builtin:bash", {})).rejects.toThrow("not available");
    expect(effect).not.toHaveBeenCalled();
    const offered = new FakeSession({
      tools: [tool],
      availableTools: ["custom:hidden"],
      onPermissionRequest: buildPermissionGate(),
    });
    await offered.callTool("hidden", {});
    expect(effect).toHaveBeenCalledOnce();
    expect(buildSessionToolFilter([])).toEqual({ availableTools: [] });
  });

  it("refuses the Change stub without an approval", async () => {
    const config = createStubSessionConfig();
    const session = new FakeSession(config);
    await expect(session.callTool("merge_pr", {})).rejects.toThrow("approval");
    await expect(session.callTool("spi_brief", {})).resolves.toBe("ships at M3");
  });
});

describe("handler policy boundary", () => {
  it.each<ToolTier>(["Read", "Local", "Command", "Change", "Consequential"])(
    "refuses a throwing %s check before the outside effect",
    async (tier) => {
      const effect = vi.fn();
      const check = vi.fn(() => {
        throw new Error("policy store unreadable");
      });
      const tool = buildGatedTool(
        { name: "probe", tier, milestone: "M3" },
        z.strictObject({}),
        check,
        effect,
      );
      const session = new FakeSession({
        tools: [tool],
        availableTools: ["custom:probe"],
        onPermissionRequest: buildPermissionGate(),
      });
      await expect(session.callTool("probe", {})).rejects.toThrow("policy check failed");
      expect(check).toHaveBeenCalledOnce();
      expect(effect).not.toHaveBeenCalled();
    },
  );

  it("refuses rejected and unreadable checks, and invalid arguments, without an effect", async () => {
    for (const check of [
      () => ({ allowed: false as const, reason: "declined" }),
      async () => {
        throw new Error("offline");
      },
      () => JSON.parse('{"allowed":"yes"}'),
      () => JSON.parse("null"),
    ]) {
      const effect = vi.fn();
      const tool = buildGatedTool(
        { name: "probe", tier: "Change", milestone: "M4" },
        z.strictObject({}),
        check,
        effect,
      );
      await expect(tool.handler({}, invocation)).rejects.toThrow("refused");
      expect(effect).not.toHaveBeenCalled();
    }
    const effect = vi.fn();
    const check = vi.fn(allow);
    const tool = buildGatedTool(
      { name: "probe", tier: "Read", milestone: "M3" },
      z.strictObject({}),
      check,
      effect,
    );
    await expect(tool.handler({ bypass: true }, invocation)).rejects.toThrow("arguments refused");
    expect(check).not.toHaveBeenCalled();
    expect(effect).not.toHaveBeenCalled();
  });

  it("validates before checking, checks before effect, and preserves effect errors", async () => {
    const order: string[] = [];
    const tool = buildGatedTool(
      { name: "probe", tier: "Read", milestone: "M3" },
      z.object({ id: z.number() }),
      (call) => {
        order.push("check");
        expect(call.args).toEqual({ id: 7 });
        return allow();
      },
      (args) => {
        order.push("effect");
        expect(args.id).toBe(7);
        throw new Error("outside failed");
      },
    );
    await expect(tool.handler({ id: 7 }, invocation)).rejects.toThrow("outside failed");
    expect(order).toEqual(["check", "effect"]);
  });

  it("defaults every non-Read tier to refusal before an effect", async () => {
    for (const tier of ["Local", "Command", "Change", "Consequential"] as const) {
      const effect = vi.fn();
      const tool = buildGatedTool(
        { name: "probe", tier, milestone: "M5" },
        z.strictObject({}),
        undefined,
        effect,
      );
      await expect(tool.handler({}, invocation)).rejects.toThrow("refused");
      expect(effect).not.toHaveBeenCalled();
    }
  });
});

const requests: PermissionRequest[] = [
  {
    kind: "shell",
    canOfferSessionApproval: true,
    commands: [],
    fullCommandText: "echo test",
    hasWriteFileRedirection: false,
    intention: "test",
    possiblePaths: [],
    possibleUrls: [],
  },
  {
    kind: "write",
    canOfferSessionApproval: true,
    diff: "",
    fileName: "/tmp/test",
    intention: "test",
  },
  { kind: "read", path: "/tmp/test", intention: "test" },
  { kind: "url", url: "https://example.com", intention: "test" },
  {
    kind: "mcp",
    readOnly: true,
    serverName: "user-configured",
    toolName: "test",
    toolTitle: "test",
  },
  { kind: "memory", fact: "test" },
  { kind: "custom-tool", skipPermission: true, toolName: "spi_brief", toolDescription: "test" },
  { kind: "hook", toolName: "test" },
  { kind: "extension-management", operation: "reload" },
  {
    kind: "workflow",
    approvalKey: "test",
    canPersistApproval: false,
    description: "test",
    name: "test",
    operation: "run",
    phases: [],
  },
  { kind: "extension-permission-access", extensionName: "test", capabilities: ["shell"] },
  { kind: "extension-env-access", extensionName: "test", environmentVariables: ["TOKEN"] },
];

describe("SDK permission boundary", () => {
  it("executes the effect if the session gate grants once (positive harness control)", async () => {
    const effect = vi.fn(() => "outside");
    const session = new FakeSession({
      ...createStubSessionConfig(),
      onPermissionRequest: () => ({ kind: "approve-once" }),
    });
    await expect(session.requestPermission({ kind: "memory", fact: "test" }, effect)).resolves.toBe(
      "outside",
    );
    expect(effect).toHaveBeenCalledOnce();
  });

  it.each(requests)("denies $kind without running its outside effect", async (request) => {
    const effect = vi.fn();
    const session = new FakeSession(createStubSessionConfig());
    await expect(session.requestPermission(request, effect)).rejects.toThrow("permission refused");
    expect(effect).not.toHaveBeenCalled();
  });

  it("denies unknown runtime kinds rather than inheriting Keelson's pass-through", async () => {
    const effect = vi.fn();
    const session = new FakeSession(createStubSessionConfig());
    await expect(
      session.requestPermission(JSON.parse('{"kind":"future-kind"}'), effect),
    ).rejects.toThrow("permission refused");
    expect(effect).not.toHaveBeenCalled();
    expect([...GATED_KINDS].sort()).toEqual(requests.map(({ kind }) => kind).sort());
  });

  it("scripts calls through the same session boundary", async () => {
    const session = new FakeSession(createStubSessionConfig());
    await expect(session.run([{ kind: "tool", name: "spi_brief", args: {} }])).resolves.toEqual([
      "ships at M3",
    ]);
    const effect = vi.fn();
    await expect(
      session.run([{ kind: "permission", request: { kind: "memory", fact: "test" }, effect }]),
    ).rejects.toThrow("permission refused");
    expect(effect).not.toHaveBeenCalled();
  });
});
