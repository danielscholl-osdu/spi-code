// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import type {
  EventOf,
  JournalEntry,
  ThreadEvent,
  ThreadSummary,
  ThreadTimeline,
  TimelineMessage,
  TimelineTurn,
  TurnEnd,
} from "./types.js";

export class Timeline {
  readonly messages: TimelineMessage[] = [];
  private readonly turns: TimelineTurn[] = [];
  private readonly messagesById = new Map<string, TimelineMessage>();
  private readonly recovery: string[] = [];
  private sequence: number;
  private updatedAt: number;

  constructor(readonly created: EventOf<"thread.created">) {
    this.sequence = created.sequence;
    this.updatedAt = created.at;
  }

  get active(): TimelineTurn | undefined {
    const turn = this.turns.at(-1);
    return turn?.outcome === "running" ? turn : undefined;
  }

  summary(): ThreadSummary {
    return {
      id: this.created.threadId,
      thread: { ...this.created.thread },
      status: this.active?.approvals.some((approval) => !approval.end)
        ? "Waiting on you"
        : this.active
          ? "Working"
          : "Settled",
      sequence: this.sequence,
      updatedAt: this.updatedAt,
    };
  }

  snapshot(): ThreadTimeline {
    return {
      ...this.summary(),
      ...structuredClone({ messages: this.messages, turns: this.turns }),
    };
  }

  instructions(): string {
    if (!this.recovery.length) return "";
    return [
      "Thread work cancelled after an interruption. Inspect current state before continuing.",
      ...this.recovery,
    ].join("\n");
  }

  apply(event: Exclude<ThreadEvent, { type: "thread.created" }>): void {
    this.sequence = event.sequence;
    this.updatedAt = event.at;
    switch (event.type) {
      case "message.sent": {
        const message: TimelineMessage = {
          id: event.messageId,
          message: event.message,
          status: "queued",
        };
        this.messages.push(message);
        this.messagesById.set(message.id, message);
        return;
      }
      case "message.cancelled":
        this.queuedMessage(event.messageId).status = "cancelled";
        return;
      case "turn.started":
        assert(!this.active, "A thread may run only one turn at a time");
        this.queuedMessage(event.messageId).status = "started";
        this.turns.push({
          id: event.turnId,
          messageId: event.messageId,
          outcome: "running",
          text: "",
          tools: [],
          approvals: [],
        });
        return;
    }

    const turn = this.active;
    assert(turn?.id === event.turnId, "Journal event has no matching active turn");
    switch (event.type) {
      case "assistant.delta":
        turn.text += event.text;
        break;
      case "tool.started":
        turn.tools.push({ start: event });
        break;
      case "tool.finished":
      case "tool.cancelled": {
        const tool = turn.tools.find(({ start }) => start.callId === event.callId);
        assert(tool && !tool.end, "Journal event has no matching open tool call");
        tool.end = event;
        break;
      }
      case "approval.requested":
        turn.approvals.push({ request: event });
        break;
      case "approval.resolved":
      case "approval.cancelled": {
        const approval = turn.approvals.find(
          ({ request }) => request.approvalId === event.approvalId,
        );
        assert(approval && !approval.end, "Journal event has no matching pending approval");
        approval.end = event;
        break;
      }
      case "turn.finished":
        turn.outcome = event.outcome;
        if (event.outcome === "completed") this.recovery.length = 0;
        if (event.outcome === "cancelled") this.reportInterruption(turn);
        break;
    }
  }

  private queuedMessage(id: string): TimelineMessage {
    const message = this.messagesById.get(id);
    assert(message?.status === "queued", "Journal event has no matching queued message");
    return message;
  }

  private reportInterruption(turn: TimelineTurn): void {
    this.recovery.push(`Turn ${turn.id}: cancelled.`);
    for (const { start, end } of turn.tools) {
      if (end?.type !== "tool.cancelled") continue;
      const process = end.processState ? ` Process state: ${end.processState}.` : "";
      this.recovery.push(`Tool call ${start.callId}: cancelled.${process}`);
    }
    for (const { request, end } of turn.approvals) {
      if (end?.type === "approval.cancelled")
        this.recovery.push(`Approval ${request.approvalId}: cancelled.`);
    }
  }
}

export function finishTurn(turn: TimelineTurn, end: TurnEnd): JournalEntry[] {
  const events: JournalEntry[] = [];
  const turnId = turn.id;
  const reason = "reason" in end ? end.reason : "turn-ended";
  const at = Date.now();
  for (const tool of turn.tools) {
    if (tool.end) continue;
    events.push({
      type: "tool.cancelled",
      turnId,
      callId: tool.start.callId,
      reason,
      durationMs: Math.max(0, at - tool.start.at),
      ...(tool.start.kind === "command" ? { processState: "not known" } : {}),
    });
  }
  for (const { request, end } of turn.approvals) {
    if (!end)
      events.push({ type: "approval.cancelled", turnId, approvalId: request.approvalId, reason });
  }
  events.push({ type: "turn.finished", turnId, ...end });
  return events;
}
