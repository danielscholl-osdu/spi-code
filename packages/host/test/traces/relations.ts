// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SessionEvent } from "@github/copilot-sdk";
import type { TraceOp } from "./trace.js";

const LEAKS: readonly [string, RegExp][] = [
  ["an email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/u],
  ["a GitHub token", /\bgh[opsuor]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/u],
  ["a GitLab token", /\bglpat-[A-Za-z0-9_-]{20,}/u],
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/u],
  ["a bearer credential", /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/u],
];

export function findLeaks(text: string): string[] {
  return LEAKS.flatMap(([name, pattern]) => (pattern.test(text) ? [name] : []));
}

const PROTECTED = /^(?:id|parentId|type|op|toolName|success|aborted)$|Id$/u;

/** Paths whose value the redactor changed although an id or a field the tracker branches on. */
export function protectedChanges(before: unknown, after: unknown, path = ""): string[] {
  if (typeof before !== typeof after || Array.isArray(before) !== Array.isArray(after))
    return [path || "(root)"];
  if (before && after && typeof before === "object" && typeof after === "object") {
    const left = before as Record<string, unknown>;
    const right = after as Record<string, unknown>;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].flatMap((key) =>
      key in left && key in right
        ? protectedChanges(left[key], right[key], `${path}.${key}`)
        : [`${path}.${key}`],
    );
  }
  if (before === after) return [];
  const key = path.slice(path.lastIndexOf(".") + 1);
  return PROTECTED.test(key) || typeof before !== "string" ? [path] : [];
}

type EventOf<T extends SessionEvent["type"]> = Extract<SessionEvent, { type: T }>;

export interface Turn {
  readonly index: number;
  readonly ops: readonly TraceOp[];
  readonly messageId: string | undefined;
  readonly history: readonly SessionEvent[];
  readonly events: readonly SessionEvent[];
}

/** One turn per host send: its ops up to the next send or restart. */
export function turns(ops: readonly TraceOp[]): Turn[] {
  const result: TraceOp[][] = [];
  for (const op of ops) {
    if (op.op === "host" && op.action === "send") result.push([op]);
    else if (op.op === "host" && op.action === "restart") result.push([]);
    else result.at(-1)?.push(op);
  }
  return result
    .filter((segment) => segment[0]?.op === "host")
    .map((segment, index) => ({
      index,
      ops: segment,
      messageId: segment.flatMap((op) => (op.op === "sent" ? [op.messageId] : []))[0],
      history: segment.flatMap((op) => (op.op === "history" ? op.events : [])),
      events: segment.flatMap((op) => (op.op === "event" ? [op.event] : [])),
    }));
}

const of = <T extends SessionEvent["type"]>(events: readonly SessionEvent[], type: T) =>
  events.filter((event): event is EventOf<T> => event.type === type && !event.agentId);

/** The tool starts a turn owns, by position: after its send, main agent, a call id not in its history. */
export function ownedToolStarts(turn: Turn): string[] {
  const old = new Set(of(turn.history, "tool.execution_start").map(({ data }) => data.toolCallId));
  return of(turn.events, "tool.execution_start")
    .map(({ data }) => data.toolCallId)
    .filter((id) => !old.has(id));
}

const verdict = (checks: readonly boolean[]) =>
  checks.length === 0
    ? "none"
    : checks.every(Boolean)
      ? "yes"
      : checks.some(Boolean)
        ? "some"
        : "no";

export function relations(ops: readonly TraceOp[]): Record<string, string>[] {
  const opens = ops.filter((op) => op.op === "open");
  return turns(ops).map((turn) => {
    const users = of(turn.events, "user.message");
    const echo = users.find(({ data }) => data.messageId === turn.messageId);
    const starts = of(turn.events, "assistant.turn_start");
    const ends = of(turn.events, "assistant.turn_end");
    const oldTurns = new Set(
      of(turn.history, "assistant.turn_start").map(({ data }) => data.turnId),
    );
    const owned = new Set(ownedToolStarts(turn));
    let current: string | undefined;
    const toolTurns: boolean[] = [];
    const startTurns = new Map<string, string | undefined>();
    for (const event of turn.events) {
      if (event.agentId) continue;
      if (event.type === "assistant.turn_start") current = event.data.turnId;
      if (event.type === "tool.execution_start" && owned.has(event.data.toolCallId)) {
        toolTurns.push(event.data.turnId === current);
        startTurns.set(event.data.toolCallId, event.data.turnId);
      }
    }
    const announced = new Set<string>();
    const deltas: boolean[] = [];
    for (const event of turn.events) {
      if (event.type === "assistant.message_start") announced.add(event.data.messageId);
      if (event.type === "assistant.message_delta")
        deltas.push(announced.has(event.data.messageId));
    }
    const lastEnd = turn.events
      .map((event, at) => (event.type === "assistant.turn_end" && !event.agentId ? at : -1))
      .reduce((last, at) => Math.max(last, at), -1);
    const open = turn.ops.find((op) => op.op === "open");
    const before = open ? opens[opens.indexOf(open) - 1] : undefined;
    return {
      "user.message echoes the sent message id": verdict(
        echo ? [true] : users.length ? [false] : [],
      ),
      "user.message carries a turn id": verdict(echo ? ["turnId" in echo.data] : []),
      "first turn id is 0": verdict(starts.slice(0, 1).map(({ data }) => data.turnId === "0")),
      "turn ids repeat ones in history": verdict(
        oldTurns.size ? starts.map(({ data }) => oldTurns.has(data.turnId)) : [],
      ),
      "tool starts carry the current turn id": verdict(toolTurns),
      "tool completes carry their start's turn id": verdict(
        of(turn.events, "tool.execution_complete")
          .filter(({ data }) => startTurns.has(data.toolCallId))
          .map(({ data }) => startTurns.get(data.toolCallId) === data.turnId),
      ),
      "deltas follow their message_start": verdict(deltas),
      "assistant.message names the sent message": verdict(
        of(turn.events, "assistant.message").map(
          ({ data }) => data.originatingMessageId === turn.messageId,
        ),
      ),
      "every turn_start has its turn_end": verdict(
        starts.map(({ data }) => ends.some((end) => end.data.turnId === data.turnId)),
      ),
      "session.idle follows the last turn_end": verdict(
        lastEnd < 0 ? [] : [turn.events.slice(lastEnd).some(({ type }) => type === "session.idle")],
      ),
      "a resumed session keeps its id": verdict(
        open?.op === "open" && open.resumeId !== undefined
          ? [
              open.resumeId === open.sessionId &&
                before?.op === "open" &&
                before.sessionId === open.resumeId,
            ]
          : [],
      ),
      "a resumed history holds the earlier turns": verdict(
        open?.op === "open" && open.resumeId !== undefined ? [oldTurns.size > 0] : [],
      ),
    };
  });
}

const STREAMING = new Set([
  "assistant.streaming_delta",
  "assistant.message_delta",
  "assistant.tool_call_delta",
  "assistant.reasoning_delta",
  "hook.start",
  "hook.end",
]);

/** Event types in order, without streaming and hook events, a run of one type shown once, and the adapter's calls marked with @. */
export function order(ops: readonly TraceOp[]): string[][] {
  return turns(ops).map((turn) =>
    turn.ops
      .flatMap((op) =>
        op.op === "event"
          ? op.event.agentId || STREAMING.has(op.event.type)
            ? []
            : [op.event.type]
          : ["send", "sent", "history", "abort", "release", "open"].includes(op.op)
            ? [`@${op.op}`]
            : op.op === "host"
              ? [`host ${op.action}`]
              : [],
      )
      .filter((type, index, all) => type !== all[index - 1]),
  );
}

/** What differs between a recorded trace and a live run; only relations count as a failure. */
export function compareTraces(recorded: readonly TraceOp[], live: readonly TraceOp[]) {
  const orderLines: string[] = [];
  const relationLines: string[] = [];
  const was = order(recorded);
  const now = order(live);
  const wasRelations = relations(recorded);
  const nowRelations = relations(live);
  if (was.length !== now.length)
    relationLines.push(`${was.length} turns recorded, ${now.length} live`);
  for (const [index, sequence] of was.entries()) {
    const current = now[index];
    if (current && current.join(" > ") !== sequence.join(" > "))
      orderLines.push(
        `turn ${index + 1}\n    recorded ${sequence.join(" > ")}\n    live     ${current.join(" > ")}`,
      );
    const left = wasRelations[index] ?? {};
    const right = nowRelations[index] ?? {};
    for (const [name, value] of Object.entries(left)) {
      const other = right[name] ?? "none";
      if (value !== other && value !== "none" && other !== "none")
        relationLines.push(`turn ${index + 1} ${name}: recorded ${value}, live ${other}`);
    }
  }
  return { order: orderLines, relations: relationLines };
}

/** session.usage_info before and after each message that carries a context chip. */
export function usageAround(ops: readonly TraceOp[]): string[] {
  const lines: string[] = [];
  const format = (event: SessionEvent | undefined) => {
    if (event?.type !== "session.usage_info") return "not seen";
    const {
      currentTokens,
      systemTokens,
      conversationTokens,
      toolDefinitionsTokens,
      messagesLength,
      tokenLimit,
    } = event.data;
    return `current ${currentTokens} of ${tokenLimit}, system ${systemTokens ?? "?"}, conversation ${conversationTokens ?? "?"}, tools ${toolDefinitionsTokens ?? "?"}, messages ${messagesLength}`;
  };
  const usage = (op: TraceOp) =>
    op.op === "event" && op.event.type === "session.usage_info" ? [op.event] : [];
  for (const [index, op] of ops.entries()) {
    if (op.op !== "host" || op.action !== "send" || !op.attachments?.length) continue;
    const next = ops.findIndex(
      (later, at) => at > index && later.op === "host" && later.action !== "stop",
    );
    const before = ops.slice(0, index).flatMap(usage).at(-1);
    const after = ops.slice(index + 1, next < 0 ? undefined : next).flatMap(usage);
    const chips = op.attachments.map(({ name, bytes }) => `${name} ${bytes} bytes`).join(", ");
    lines.push(`chip message (${chips})`);
    lines.push(`usage before: ${format(before)}`);
    for (const [at, event] of after.entries())
      lines.push(`usage after ${at + 1}: ${format(event)}`);
    if (!after.length) lines.push("usage after: not seen");
  }
  return lines;
}
