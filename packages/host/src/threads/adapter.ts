// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import type { Tool, ToolResultObject } from "@github/copilot-sdk";
import { ReasoningEffortSchema } from "@spi-code/contracts";
import type {
  JsonValue,
  RuntimeEvents,
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
  private readonly opening = new Set<string>();
  private closed = false;

  constructor(
    private readonly runtime: Runtime,
    private readonly ids: SessionIds,
    private readonly modelRedactor: ToolOutputRedactor,
  ) {}

  async run(input: RuntimeTurn<Tool>, events: RuntimeEvents): Promise<void> {
    const { threadId, message, signal } = input;
    const workspace = input.workspace as AskingTurnWorkspace;
    if (workspace.reading !== undefined) record(events, "workspace.reading", workspace.reading);
    const { data: reasoningEffort } = ReasoningEffortSchema.safeParse(message.reasoningEffort);
    const settings: Settings = {
      model: message.model ?? "auto",
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    };
    const lease = await this.open(input, workspace.sandbox, settings, events);
    const { session } = lease;
    lease.active = { events, signal };
    try {
      await this.send(input, session, events);
    } catch (error) {
      const disconnected = !session.connected;
      await this.release(threadId, lease).catch(() => {});
      if (!signal.aborted && disconnected && !this.closed) {
        await this.runtime.restartThreadClient(lease.generation);
        if (this.sessions.get(threadId) === lease) this.sessions.delete(threadId);
        await this.open(input, workspace.sandbox, settings, events);
        throw new Error("Copilot disconnected. The in-flight tool effects are not known.");
      }
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
    if (this.opening.has(threadId)) throw new Error("Copilot is still opening this thread.");
    this.opening.add(threadId);
    try {
      return await this.acquire(input, workspace, settings, events);
    } finally {
      this.opening.delete(threadId);
    }
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
      existing.tools.map(({ name }) => name).join() === tools.map(({ name }) => name).join()
    ) {
      if (
        existing.settings.model !== settings.model ||
        existing.settings.reasoningEffort !== settings.reasoningEffort
      ) {
        await existing.session.setModel(settings.model, settings.reasoningEffort);
        existing.settings = settings;
      }
      existing.tools = tools;
      return existing;
    }
    if (existing) await this.release(threadId, existing);
    const resumeId = this.ids.get(threadId);
    let lease: Lease | undefined;
    const current = () => (lease?.active?.signal.aborted ? undefined : lease?.active?.events);
    const options: ThreadSessionOptions = {
      ...settings,
      ...(instructions ? { systemMessage: { content: instructions } } : {}),
      tools: tools.map((tool) => ({
        ...tool,
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
        onPostToolUse: ({ toolResult }) => ({
          modifiedResult: redactResult(this.modelRedactor, toolResult),
        }),
      },
      onPermissionRequest: askingPermission(workspace, current),
      onPermissionDenied: askingPermission(workspace, current, true),
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
  ): Promise<void> {
    let finish: (error?: unknown) => void = () => {};
    const promise = new Promise<void>((resolve, reject) => {
      finish = (error) => (error === undefined ? resolve() : reject(error));
    });
    let unsubscribe: (() => void) | undefined;
    const abort = () => {
      void releaseWithin(session.abort(), 700)
        .finally(() => finish(signal.reason))
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
          const prompt = [...context.attachments, ...(message.attachments ?? [])]
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
      await promise;
    } finally {
      unsubscribe?.();
      clearInterval(check);
      signal.removeEventListener("abort", abort);
    }
  }

  private async release(threadId: string, lease: Lease) {
    lease.active = undefined;
    lease.releasing ??= lease.session.release();
    await releaseWithin(lease.releasing, 700);
    if (this.sessions.get(threadId) === lease) this.sessions.delete(threadId);
  }

  async stop() {
    this.closed = true;
    await this.runtime.stop();
    this.sessions.clear();
  }
}
