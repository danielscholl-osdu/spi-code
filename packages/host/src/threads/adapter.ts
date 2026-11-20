// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import type { Tool, ToolResultObject } from "@github/copilot-sdk";
import { ReasoningEffortSchema } from "@spi-code/contracts";
import type {
  JsonValue,
  RuntimeEvents,
  RuntimeStop,
  RuntimeTurn,
  ThreadRuntime,
  ToolOutputRedactor,
} from "@spi-code/threads";
import { z } from "zod";
import type {
  CopilotRuntime,
  ThreadCopilotSession,
  ThreadSessionOptions,
} from "../copilot/runtime.js";
import type { SandboxWorkspace } from "../copilot/sandbox.js";
import { isSpiReadTool } from "../tools/spi-reads.js";
import { trackTurn } from "./events.js";
import { askingPermission } from "./permissions.js";

type Runtime = Pick<
  CopilotRuntime,
  "openThreadSession" | "stop" | "restartThreadClient" | "clientGeneration"
>;
type Settings = {
  model: string;
  reasoningEffort?: NonNullable<ThreadSessionOptions["reasoningEffort"]>;
};
export type AskingTurnWorkspace = { cwd: string; sandbox: SandboxWorkspace; reading?: JsonValue };
type Lease = {
  session: ThreadCopilotSession;
  generation: number;
  settings: Settings;
  instructions: string;
  active: { events: RuntimeEvents; signal: AbortSignal } | undefined;
  tools: readonly Tool[];
  workspace: SandboxWorkspace;
  releasing?: Promise<void>;
};

function record(events: RuntimeEvents, name: string, result: JsonValue) {
  const callId = randomUUID();
  events.toolStarted({ callId, name, kind: "tool", arguments: null });
  events.toolFinished({ callId, outcome: "completed", result });
}

function redactResult(redactor: ToolOutputRedactor, result: ToolResultObject): ToolResultObject {
  return {
    resultType: result.resultType,
    textResultForLlm: redactor.text(result.textResultForLlm),
    ...(result.error === undefined ? {} : { error: redactor.text(result.error) }),
  };
}

export type SessionIds = {
  get(id: string): string | undefined;
  set(id: string, sessionId: string): void;
};

async function releaseWithin<T>(operation: Promise<T>, ms: number): Promise<T> {
  const timer = new AbortController();
  try {
    return await Promise.race([
      operation,
      setTimeout(ms, undefined, { signal: timer.signal }).then(() => {
        throw new Error("Copilot did not release the session in time.");
      }),
    ]);
  } finally {
    timer.abort();
  }
}

export class CopilotThreadAdapter implements ThreadRuntime<Tool> {
  private readonly sessions = new Map<string, Lease>();
  private readonly opening = new Map<string, Promise<Lease>>();
  private closed = false;

  constructor(
    private readonly runtime: Runtime,
    private readonly ids: SessionIds,
    private readonly modelRedactor: ToolOutputRedactor,
  ) {}

  async run(input: RuntimeTurn<Tool>, events: RuntimeEvents): Promise<RuntimeStop | undefined> {
    const { threadId, message, signal } = input;
    const workspace = input.workspace as AskingTurnWorkspace;
    if (workspace.reading !== undefined) record(events, "workspace.reading", workspace.reading);
    const { data: reasoningEffort } = ReasoningEffortSchema.safeParse(message.reasoningEffort);
    const settings: Settings = {
      model: message.model ?? "auto",
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    };
    const lease = await this.open(input, workspace.sandbox, settings, events);
    signal.throwIfAborted();
    const { session } = lease;
    lease.active = { events, signal };
    try {
      return await this.send(input, session, events);
    } catch (error) {
      const disconnected = !session.connected;
      await this.release(threadId, lease, disconnected && !this.closed).catch(() => {});
      if (!signal.aborted && disconnected)
        throw new Error("Copilot disconnected. The in-flight tool effects are not known.");
      throw error;
    } finally {
      lease.active = undefined;
    }
  }

  private async open(
    input: RuntimeTurn<Tool>,
    workspace: SandboxWorkspace,
    settings: Settings,
    events: RuntimeEvents,
  ): Promise<Lease> {
    const { threadId } = input;
    let opening = this.opening.get(threadId);
    while (opening) {
      await opening.catch(() => {});
      opening = this.opening.get(threadId);
    }
    const acquired = this.acquire(input, workspace, settings, events).finally(() => {
      this.opening.delete(threadId);
    });
    this.opening.set(threadId, acquired);
    return acquired;
  }

  private async acquire(
    input: RuntimeTurn<Tool>,
    workspace: SandboxWorkspace,
    settings: Settings,
    events: RuntimeEvents,
  ): Promise<Lease> {
    const { threadId, signal, context, tools } = input;
    const instructions = context.instructions;
    signal.throwIfAborted();
    if (this.closed) throw new Error("Thread runtime is shutting down.");
    const existing = this.sessions.get(threadId);
    if (
      existing?.session.connected &&
      !existing.releasing &&
      existing.instructions === instructions &&
      existing.tools.map(({ name }) => name).join() === tools.map(({ name }) => name).join() &&
      JSON.stringify(existing.workspace) === JSON.stringify(workspace)
    ) {
      if (
        existing.settings.model !== settings.model ||
        existing.settings.reasoningEffort !== settings.reasoningEffort
      ) {
        try {
          const applied = await existing.session.setModel(settings.model, settings.reasoningEffort);
          existing.settings = settings;
          if (applied === "not known") {
            record(events, "session.settings", { reasoningEffort: applied });
          }
        } catch (error) {
          await this.release(threadId, existing, !existing.session.connected && !this.closed).catch(
            () => {},
          );
          throw error;
        }
      }
      existing.tools = tools;
      return existing;
    }
    if (existing) await this.release(threadId, existing);
    signal.throwIfAborted();
    if (this.closed) throw new Error("Thread runtime is shutting down.");
    const resumeId = this.ids.get(threadId);
    let lease: Lease | undefined;
    const current = () => (lease?.active?.signal.aborted ? undefined : lease?.active?.events);
    const spiReads = new Set(tools.map(({ name }) => name).filter(isSpiReadTool));
    const options: ThreadSessionOptions = {
      ...settings,
      ...(instructions ? { systemMessage: { content: instructions } } : {}),
      tools: tools.map((tool) => ({
        ...tool,
        skipPermission: false,
        handler: async (args, invocation) => {
          const active = lease?.tools.find(({ name }) => name === tool.name);
          try {
            if (!current() || !active?.handler) throw new Error("No active thread turn.");
            const result = await active.handler(args, invocation);
            return this.modelRedactor.value(z.json().parse(result));
          } catch (error) {
            return {
              resultType: "failure",
              textResultForLlm: this.modelRedactor.text(
                error instanceof Error ? error.message : "The SPI tool could not finish.",
              ),
            };
          }
        },
      })),
      hooks: {
        onPostToolUse: ({ toolResult }) => {
          try {
            return { modifiedResult: redactResult(this.modelRedactor, toolResult) };
          } catch {
            return {
              modifiedResult: { resultType: "failure", textResultForLlm: "Tool result withheld." },
            };
          }
        },
      },
      onPermissionRequest: askingPermission(workspace, current, { spiReads }),
      onPermissionDenied: askingPermission(workspace, current, { gateDenied: true }),
    };
    let session: ThreadCopilotSession;
    try {
      session = await this.runtime.openThreadSession(workspace, {
        ...options,
        ...(resumeId ? { resumeId } : {}),
      });
    } catch (error) {
      if (
        !resumeId ||
        signal.aborted ||
        !(error instanceof Error) ||
        !/session.*(?:not found|does not exist)|(?:not found|no such) session/iu.test(error.message)
      )
        throw error;
      session = await this.runtime.openThreadSession(workspace, options);
      record(
        events,
        "session.replaced",
        "Copilot's earlier session is unavailable. This turn starts a new session.",
      );
    }
    if (signal.aborted || this.closed) {
      await session.release();
      throw new Error("Thread was stopped before the session opened.");
    }
    this.ids.set(threadId, session.sessionId);
    lease = {
      session,
      generation: this.runtime.clientGeneration,
      settings,
      instructions,
      workspace,
      active: undefined,
      tools,
    };
    this.sessions.set(threadId, lease);
    return lease;
  }

  private async send(
    { message, context, signal }: RuntimeTurn<Tool>,
    session: ThreadCopilotSession,
    events: RuntimeEvents,
  ): Promise<RuntimeStop | undefined> {
    let finish: (result?: Error | RuntimeStop) => void = () => {};
    let interrupt: (reason: unknown) => void = () => {};
    const promise = new Promise<RuntimeStop | undefined>((resolve, reject) => {
      finish = (result) => (result instanceof Error ? reject(result) : resolve(result));
      interrupt = reject;
    });
    let unsubscribe: (() => void) | undefined;
    const abort = () => {
      void releaseWithin(session.abort(), 700)
        .finally(() => interrupt(signal.reason))
        .catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    const check = setInterval(() => {
      if (!session.connected) finish(new Error("Copilot disconnected during the turn."));
    }, 250);
    try {
      signal.throwIfAborted();
      await Promise.race([
        (async () => {
          const history = await session.getEvents();
          signal.throwIfAborted();
          const tracker = trackTurn(history, events, finish);
          unsubscribe = session.on(tracker.observe);
          const prompt = context.attachments
            .map(({ name, content }) => `${name}\n${content}`)
            .concat(message.prompt)
            .join("\n\n");
          const { messageId, sandbox } = await session.send({ prompt });
          if (signal.aborted) return;
          if (sandbox.kind === "not-confined") record(events, "sandbox.unavailable", sandbox);
          tracker.sent(messageId);
        })(),
        promise,
      ]);
      return await promise;
    } finally {
      unsubscribe?.();
      clearInterval(check);
      signal.removeEventListener("abort", abort);
    }
  }

  private async release(threadId: string, lease: Lease, restart = false) {
    lease.active = undefined;
    lease.releasing ??= restart
      ? lease.session
          .release()
          .catch(() => {})
          .then(() => this.runtime.restartThreadClient(lease.generation))
      : lease.session.release();
    await lease.releasing;
    if (this.sessions.get(threadId) === lease) this.sessions.delete(threadId);
  }

  async stop() {
    this.closed = true;
    await this.runtime.stop();
    this.sessions.clear();
  }
}
