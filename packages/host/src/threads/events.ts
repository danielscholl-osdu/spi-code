// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SessionEvent } from "@github/copilot-sdk";
import type { RuntimeEvents } from "@spi-code/threads";

export function trackTurn(
  history: readonly SessionEvent[],
  events: RuntimeEvents,
  finish: (error?: Error) => void,
) {
  const oldCalls = new Set(
    history.flatMap((event) =>
      event.type === "tool.execution_start" ? [event.data.toolCallId] : [],
    ),
  );
  const calls = new Map<string, string>();
  const replies = new Set<string>();
  const streamed = new Set<string>();
  const buffered: SessionEvent[] = [];
  let messageId: string | undefined;
  let turnId: string | undefined;
  let consumed = false;
  let ended = false;

  function observe(event: SessionEvent) {
    if (event.agentId) return;
    if (event.type === "session.shutdown") {
      finish(new Error("Copilot disconnected during the turn."));
      return;
    }
    if (!messageId) {
      buffered.push(event);
      return;
    }
    switch (event.type) {
      case "user.message":
        if (event.data.messageId === messageId) {
          consumed = true;
          turnId = event.data.turnId;
        }
        break;
      case "assistant.turn_start":
        if (consumed && (turnId === undefined || ended || turnId === event.data.turnId)) {
          turnId = event.data.turnId;
          ended = false;
        }
        break;
      case "assistant.message_start":
        if (turnId && !ended) replies.add(event.data.messageId);
        break;
      case "assistant.message_delta":
        if (!ended && replies.has(event.data.messageId)) {
          streamed.add(event.data.messageId);
          events.delta(event.data.deltaContent);
        }
        break;
      case "assistant.message":
        if (event.data.originatingMessageId === messageId) {
          consumed = true;
          if (!streamed.has(event.data.messageId)) events.delta(event.data.content);
        }
        break;
      case "tool.execution_start": {
        const { arguments: args, toolCallId, toolName, turnId: owner } = event.data;
        if (!owner || owner !== turnId || ended || oldCalls.has(toolCallId)) break;
        calls.set(toolCallId, owner);
        events.toolStarted({
          callId: toolCallId,
          name: toolName,
          kind: toolName === "bash" || toolName === "powershell" ? "command" : "tool",
          arguments: args ?? null,
        });
        break;
      }
      case "tool.execution_complete": {
        const { success, toolCallId, result, error, turnId: owner } = event.data;
        if (calls.get(toolCallId) !== owner || !owner) break;
        const output = result?.detailedContent ?? result?.content ?? error?.message ?? null;
        if (
          !success &&
          [output, error?.message].some((text) =>
            text?.startsWith("Tool execution was interrupted before a result was recorded"),
          )
        )
          break;
        events.toolFinished({
          callId: toolCallId,
          outcome: success ? "completed" : "failed",
          result: output,
        });
        break;
      }
      case "assistant.turn_end":
        if (turnId && event.data.turnId === turnId) ended = true;
        break;
      case "session.idle":
        if (consumed && ended)
          finish(event.data.aborted ? new Error("Copilot interrupted the turn.") : undefined);
        break;
      case "session.error":
        if (
          event.data.originatingMessageId ? event.data.originatingMessageId === messageId : consumed
        )
          finish(new Error(event.data.message));
        break;
    }
  }
  return {
    observe,
    sent(id: string) {
      messageId = id;
      for (const event of buffered.splice(0)) observe(event);
    },
  };
}
