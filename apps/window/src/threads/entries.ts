// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ThreadWireEvent } from "@spi-code/contracts";
import type { ModelOption, TimelineEntry, ToolCall } from "./types.js";

const CHIP_PREFIX = "context:";
const CANCELLED: Record<string, string> = {
  restart: "Not run: SPI Code restarted before it started.",
  shutdown: "Not run: SPI Code quit before it started.",
};
const ENDED: Record<string, string> = {
  restart: "Ended when SPI Code restarted.",
  shutdown: "Ended when SPI Code quit.",
  operator: "Stopped.",
  "turn-ended": "Ended.",
};

/** The model a message used, by its catalog name, else its id as the host journalled it. */
function modelLine(models: readonly ModelOption[], model?: string, effort?: string) {
  const name =
    !model || model === "auto" ? "Auto" : (models.find(({ id }) => id === model)?.name ?? model);
  return effort ? `${name} · ${effort.charAt(0).toUpperCase()}${effort.slice(1)}` : name;
}

const json = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

/** The thread's journal as timeline rows, and whether a turn is still running. */
export function threadEntries(
  events: readonly ThreadWireEvent[],
  models: readonly ModelOption[],
): { entries: TimelineEntry[]; running: boolean } {
  const entries: TimelineEntry[] = [];
  const calls = new Map<string, ToolCall>();
  let previous: { model?: string; effort?: string } | null = null;
  let running = false;
  const replace = (call: ToolCall, next: Partial<ToolCall>) => {
    const at = entries.indexOf(call);
    const updated = { ...call, ...next };
    entries[at] = updated;
    calls.set(call.id, updated);
  };
  for (const event of events) {
    switch (event.type) {
      case "message.sent": {
        const { model, reasoningEffort: effort } = event.message;
        if (previous && (previous.model !== model || previous.effort !== effort))
          entries.push({
            kind: "model-switch",
            id: `model:${event.messageId}`,
            to: modelLine(models, model, effort),
          });
        previous = { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
        const chips = (event.message.attachments ?? []).map(({ name }) =>
          name.startsWith(CHIP_PREFIX) ? name.slice(CHIP_PREFIX.length) : name,
        );
        entries.push({
          kind: "user",
          id: event.messageId,
          text: event.message.prompt,
          ...(chips.length ? { chips } : {}),
        });
        break;
      }
      case "message.cancelled":
        entries.push({
          kind: "turn-end",
          id: `cancelled:${event.messageId}`,
          state: "cancelled",
          detail: CANCELLED[event.reason] ?? "Not run.",
        });
        break;
      case "turn.started":
        running = true;
        break;
      case "assistant.delta": {
        const last = entries.at(-1);
        if (last?.kind === "assistant" && last.id.startsWith(`${event.turnId}:`))
          entries[entries.length - 1] = { ...last, text: last.text + event.text };
        else
          entries.push({
            kind: "assistant",
            id: `${event.turnId}:${event.sequence}`,
            text: event.text,
            streaming: true,
          });
        break;
      }
      case "tool.started": {
        const call: ToolCall = {
          kind: "call",
          id: event.callId,
          label: event.name,
          status: "running",
          args: json(event.arguments),
        };
        entries.push(call);
        calls.set(call.id, call);
        break;
      }
      case "tool.finished": {
        const call = calls.get(event.callId);
        if (call)
          replace(call, {
            status: event.outcome === "completed" ? "done" : "failed",
            result: json(event.result),
          });
        break;
      }
      case "tool.cancelled": {
        const call = calls.get(event.callId);
        if (call) replace(call, { status: "unknown", result: ENDED[event.reason] ?? "Ended." });
        break;
      }
      case "turn.finished": {
        running = false;
        for (const [index, entry] of entries.entries()) {
          if (
            entry.kind === "assistant" &&
            entry.streaming &&
            entry.id.startsWith(`${event.turnId}:`)
          )
            entries[index] = { ...entry, streaming: false };
          if (entry.kind === "call" && entry.status === "running")
            replace(entry, { status: "unknown" });
        }
        if (event.outcome === "failed")
          entries.push({
            kind: "turn-end",
            id: `end:${event.turnId}`,
            state: "failed",
            ...(event.failure ? { detail: event.failure } : {}),
          });
        else if (event.outcome !== "completed")
          entries.push({
            kind: "turn-end",
            id: `end:${event.turnId}`,
            state: "cancelled",
            detail: ENDED[event.reason ?? "operator"] ?? "Stopped.",
          });
        break;
      }
      default:
        break;
    }
  }
  return { entries, running };
}
