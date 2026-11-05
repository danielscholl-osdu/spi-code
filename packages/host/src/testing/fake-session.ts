// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { PermissionRequest, SessionConfig, ToolInvocation } from "@github/copilot-sdk";

export type FakeSessionConfig = Pick<
  SessionConfig,
  "tools" | "availableTools" | "onPermissionRequest"
> & {
  tools: NonNullable<SessionConfig["tools"]>;
  availableTools: string[];
  onPermissionRequest: NonNullable<SessionConfig["onPermissionRequest"]>;
};

export type FakeSessionStep =
  | { kind: "tool"; name: string; args: unknown }
  | { kind: "permission"; request: PermissionRequest; effect: () => unknown };

export class FakeSession {
  readonly sessionId = "fake-session";
  private callId = 0;

  constructor(private readonly config: FakeSessionConfig) {}

  async callTool(name: string, args: unknown): Promise<unknown> {
    if (!this.config.availableTools.includes(`custom:${name}`)) {
      throw new Error(`${name}: not available in this session.`);
    }
    const tool = this.config.tools.find((candidate) => candidate.name === name);
    if (!tool?.handler) {
      throw new Error(`${name}: no registered handler.`);
    }
    const invocation: ToolInvocation = {
      sessionId: this.sessionId,
      toolCallId: `fake-${++this.callId}`,
      toolName: name,
      arguments: args,
    };
    return tool.handler(args, invocation);
  }

  async requestPermission(request: PermissionRequest, effect: () => unknown): Promise<unknown> {
    const result = await this.config.onPermissionRequest(request, { sessionId: this.sessionId });
    const decision = result.kind === "attributed" ? result.result : result;
    switch (decision.kind) {
      case "approve-once":
      case "approve-for-session":
      case "approve-read-only-for-session":
      case "approve-for-location":
      case "approve-permanently":
        return effect();
      default:
        throw new Error(`${request.kind}: permission refused (${decision.kind}).`);
    }
  }

  async run(script: readonly FakeSessionStep[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const step of script) {
      results.push(
        await (step.kind === "tool"
          ? this.callTool(step.name, step.args)
          : this.requestPermission(step.request, step.effect)),
      );
    }
    return results;
  }
}
