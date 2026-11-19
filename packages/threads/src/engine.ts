// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ThreadJournal } from "./journal.js";
import { toolOutputRedactor } from "./redaction.js";
import { finishTurn, Timeline } from "./timeline.js";
import type {
  JournalEntry,
  RuntimeEvents,
  ThreadDefinition,
  ThreadEngineOptions,
  ThreadEvent,
  ThreadMessage,
  ThreadSummary,
  ThreadTimeline,
  ThreadTransport,
  TimelineTurn,
  TurnEnd,
  TurnOutcome,
  TurnRequest,
} from "./types.js";

interface PendingMessage {
  id: string;
  message: ThreadMessage;
  resolve(outcome: TurnOutcome): void;
  reject(error: unknown): void;
}

interface RunningTurn {
  turn: TimelineTurn;
  controller: AbortController;
  approvals: Map<string, (approved: boolean) => void>;
  done: Promise<TurnOutcome>;
}

/** One engine writes a database at a time. The caller owns the SQLite connection. */
export class ThreadEngine<Tool> {
  private readonly journal: ThreadJournal;
  private readonly threads = new Map<string, Timeline>();
  private readonly queues = new Map<string, PendingMessage[]>();
  private readonly running = new Map<string, RunningTurn>();
  private readonly subscriptions = new Map<string, Set<() => void>>();
  private closing?: Promise<void>;

  constructor(
    db: DatabaseSync,
    private readonly options: ThreadEngineOptions<Tool>,
  ) {
    this.journal = new ThreadJournal(db);
    for (const event of this.journal.load()) this.apply(event);
    for (const timeline of this.threads.values()) this.cancelInterrupted(timeline, "restart");
  }

  create(thread: ThreadDefinition): string {
    this.assertOpen();
    const id = randomUUID();
    this.record(id, [{ type: "thread.created", thread }]);
    return id;
  }

  list(): ThreadSummary[] {
    return [...this.threads.values()]
      .map((timeline) => timeline.summary())
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  read(id: string): ThreadTimeline {
    return this.get(id).snapshot();
  }

  eventsSince(id: string, sequence: number): ThreadEvent[] {
    this.get(id);
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Invalid thread sequence");
    return this.journal.since(id, sequence);
  }

  subscribe(id: string, sequence: number, transport: ThreadTransport): () => void {
    this.assertOpen();
    this.get(id);
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Invalid thread sequence");
    const listeners = this.subscriptions.get(id) ?? new Set();
    this.subscriptions.set(id, listeners);
    let cursor = sequence;
    let scheduled = false;
    const unsubscribe = () => {
      listeners.delete(deliver);
      if (!listeners.size && this.subscriptions.get(id) === listeners)
        this.subscriptions.delete(id);
    };
    const deliver = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (!listeners.has(deliver)) return;
        try {
          const events = this.journal.since(id, cursor);
          const last = events.at(-1);
          if (!last) return;
          cursor = last.sequence;
          transport.send(events);
        } catch {
          unsubscribe();
        }
      });
    };
    listeners.add(deliver);
    deliver();
    return unsubscribe;
  }

  async send(id: string, message: ThreadMessage): Promise<TurnOutcome> {
    this.assertOpen();
    const timeline = this.get(id);
    if (timeline.active && !this.running.has(id))
      throw new Error("Thread requires journal recovery");
    const messageId = randomUUID();
    const input = structuredClone(message);
    this.record(id, [{ type: "message.sent", messageId, message: input }]);
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(id) ?? [];
      queue.push({ id: messageId, message: input, resolve, reject });
      this.queues.set(id, queue);
      this.startNext(timeline);
    });
  }

  async stop(id: string): Promise<void> {
    this.get(id);
    const running = this.running.get(id);
    if (!running) return;
    if (running.turn.outcome === "running") {
      try {
        this.finish(id, running, { outcome: "stopped", reason: "operator" });
      } finally {
        this.abort(running, "operator");
      }
    }
    await running.done;
  }

  decideApproval(id: string, turnId: string, approvalId: string, approved: boolean): boolean {
    if (this.closing) return false;
    const running = this.running.get(id);
    if (running?.turn.id !== turnId || running.controller.signal.aborted) return false;
    const resolve = running.approvals.get(approvalId);
    if (!resolve) return false;
    this.record(id, [{ type: "approval.resolved", turnId, approvalId, approved }]);
    running.approvals.delete(approvalId);
    resolve(approved);
    return true;
  }

  /** Cancel accepted work, then let the runtime finish aborting before the caller closes SQLite. */
  shutdown(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      const running = [...this.running.values()];
      try {
        for (const [id, timeline] of this.threads) {
          this.cancelInterrupted(timeline, "shutdown");
          for (const pending of this.queues.get(id) ?? []) pending.resolve("cancelled");
          this.queues.delete(id);
        }
      } catch (error) {
        for (const id of this.queues.keys()) this.rejectQueue(id, error);
        throw error;
      } finally {
        for (const turn of running) this.abort(turn, "shutdown");
        await Promise.allSettled(running.map(({ done }) => done));
      }
    });
    return this.closing;
  }

  private assertOpen(): void {
    if (this.closing) throw new Error("Thread engine is shutting down");
  }

  private get(id: string): Timeline {
    const timeline = this.threads.get(id);
    if (!timeline) throw new Error("Unknown thread");
    return timeline;
  }

  private apply(event: ThreadEvent): void {
    if (event.type === "thread.created") this.threads.set(event.threadId, new Timeline(event));
    else this.get(event.threadId).apply(event);
  }

  private record(id: string, entries: JournalEntry[]): void {
    for (const event of this.journal.append(id, entries)) this.apply(event);
    for (const notify of this.subscriptions.get(id) ?? []) notify();
  }

  private cancelInterrupted(timeline: Timeline, reason: "restart" | "shutdown"): void {
    const events: JournalEntry[] = timeline.messages
      .filter((message) => message.status === "queued")
      .map(({ id }) => ({ type: "message.cancelled", messageId: id, reason }));
    if (timeline.active)
      events.push(...finishTurn(timeline.active, { outcome: "cancelled", reason }));
    if (events.length) this.record(timeline.created.threadId, events);
  }

  private startNext(timeline: Timeline): void {
    const { threadId: id } = timeline.created;
    if (this.closing || this.running.has(id)) return;
    const queue = this.queues.get(id);
    const pending = queue?.shift();
    if (!pending) return;
    if (!queue?.length) this.queues.delete(id);
    try {
      this.record(id, [{ type: "turn.started", turnId: randomUUID(), messageId: pending.id }]);
    } catch (error) {
      this.rejectQueue(id, error);
      pending.reject(error);
      return;
    }
    const turn = timeline.active;
    assert(turn, "Starting a turn requires an active journal entry");
    const done = Promise.resolve().then(() => this.run(timeline, pending.message, running));
    const running: RunningTurn = {
      turn,
      controller: new AbortController(),
      approvals: new Map(),
      done,
    };
    this.running.set(id, running);
    void done.then(
      (outcome) => {
        this.running.delete(id);
        pending.resolve(outcome);
        this.startNext(timeline);
      },
      (error) => {
        this.releaseApprovals(running);
        this.running.delete(id);
        this.rejectQueue(id, error);
        pending.reject(error);
      },
    );
  }

  private rejectQueue(id: string, error: unknown): void {
    for (const pending of this.queues.get(id) ?? []) pending.reject(error);
    this.queues.delete(id);
  }

  private async run(
    timeline: Timeline,
    message: ThreadMessage,
    running: RunningTurn,
  ): Promise<TurnOutcome> {
    const { threadId, thread } = timeline.created;
    const signal = running.controller.signal;
    const request: TurnRequest = {
      threadId,
      thread: { ...thread },
      turnId: running.turn.id,
      message,
      signal,
    };
    let outcome: "completed" | "failed" = "completed";
    try {
      signal.throwIfAborted();
      const workspace = await this.options.workspace.resolve(request);
      signal.throwIfAborted();
      const context = await this.options.context.prepare(request);
      signal.throwIfAborted();
      const tools = await this.options.tools.offer(request, workspace);
      signal.throwIfAborted();
      const recovery = timeline.instructions();
      const instructions = [context.instructions, recovery].filter(Boolean).join("\n\n");
      await this.options.runtime.run(
        { ...request, workspace, context: { ...context, instructions }, tools },
        this.runtimeEvents(threadId, running),
      );
    } catch {
      outcome = "failed";
    }
    if (running.turn.outcome !== "running") return running.turn.outcome;
    const end: TurnEnd =
      signal.reason === "operator"
        ? { outcome: "stopped", reason: "operator" }
        : signal.reason === "shutdown"
          ? { outcome: "cancelled", reason: "shutdown" }
          : { outcome };
    this.finish(threadId, running, end);
    return end.outcome;
  }

  private finish(id: string, running: RunningTurn, end: TurnEnd): void {
    this.record(id, finishTurn(running.turn, end));
    this.releaseApprovals(running);
  }

  private releaseApprovals(running: RunningTurn): void {
    for (const resolve of running.approvals.values()) resolve(false);
    running.approvals.clear();
  }

  private abort(running: RunningTurn, reason: "operator" | "shutdown"): void {
    this.releaseApprovals(running);
    running.controller.abort(reason);
  }

  private runtimeEvents(id: string, { turn, approvals, controller }: RunningTurn): RuntimeEvents {
    const turnId = turn.id;
    const live = () => !this.closing && !controller.signal.aborted && turn.outcome === "running";
    return {
      delta: (text) => {
        if (live() && text) this.record(id, [{ type: "assistant.delta", turnId, text }]);
      },
      toolStarted: ({ callId, name, kind, arguments: args }) => {
        if (!live() || turn.tools.some(({ start }) => start.callId === callId)) return;
        this.record(id, [{ type: "tool.started", turnId, callId, name, kind, arguments: args }]);
      },
      toolFinished: (completion) => {
        if (!live()) return;
        const { callId, outcome } = completion;
        const call = turn.tools.find(({ start }) => start.callId === callId);
        if (!call || call.end) return;
        const result =
          "resultChunks" in completion
            ? toolOutputRedactor.chunks(completion.resultChunks)
            : toolOutputRedactor.value(completion.result);
        this.record(id, [
          {
            type: "tool.finished",
            turnId,
            callId,
            outcome,
            result,
            resultBytes: Buffer.byteLength(JSON.stringify(result)),
            durationMs: Math.max(0, Date.now() - call.start.at),
          },
        ]);
      },
      requestApproval: async ({ approvalId, kind, detail }) => {
        if (!live() || turn.approvals.some((item) => item.request.approvalId === approvalId))
          return false;
        this.record(id, [{ type: "approval.requested", turnId, approvalId, kind, detail }]);
        return new Promise((resolve) => approvals.set(approvalId, resolve));
      },
    };
  }
}
