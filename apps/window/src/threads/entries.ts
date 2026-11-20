// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ThreadWireEvent } from "@spi-code/contracts";
import type {
  Activity,
  Approval,
  ModelOption,
  SetupStep,
  TimelineEntry,
  ToolCall,
} from "./types.js";

/** A message this window sent that the journal may not hold yet. */
export interface PendingSend {
  prompt: string;
  /** Attachment names, as the host journals them. */
  attachments?: readonly string[];
  /** When it left the window. */
  at: number;
  /** The journal's last sequence when it left; a message.sent after it is this one. */
  after: number;
}

export const scopeLabel = (scope: string) => (scope === "program" ? "Program" : scope);

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
const chipLabels = (names: readonly string[]) =>
  names.map((name) => (name.startsWith(CHIP_PREFIX) ? name.slice(CHIP_PREFIX.length) : name));
const field = (value: unknown, key: string) => {
  const found = value && typeof value === "object" ? Reflect.get(value, key) : undefined;
  return typeof found === "string" ? found : undefined;
};

/** A running call as a phase, from the arguments Copilot's built-in tools journal. */
export function toolPhase(name: string, kind: "command" | "tool", args: unknown): string {
  if (kind === "command") {
    const command = field(args, "command")?.trim().split("\n")[0];
    if (!command) return "Running a command";
    return `Running ${command.length > 48 ? `${command.slice(0, 47)}…` : command}`;
  }
  if (name === "view") {
    const file = field(args, "path")?.split(/[\\/]/).filter(Boolean).at(-1);
    return file ? `Reading ${file}` : "Reading a file";
  }
  if (name === "grep" || name === "glob") return "Searching";
  return name;
}

interface RunningTurn {
  id: string;
  since: number;
  last?: ThreadWireEvent["type"];
  preparing: boolean;
  tools: Map<string, string>;
  approvals: Set<string>;
}

/** What a running turn is doing, from its events alone; nothing when they name nothing. */
function turnPhase(turn: RunningTurn, scope: string | undefined): string | undefined {
  if (turn.approvals.size > 0) return "Waiting on you";
  const tool = [...turn.tools.values()].at(-1);
  if (tool) return tool;
  if (turn.preparing) return scope ? `Getting ${scopeLabel(scope)} ready` : "Getting ready";
  if (turn.last === "assistant.thinking") return "Thinking";
  if (turn.last === "assistant.delta") return "Writing";
  return undefined;
}

/** "4s", "1m 05s", "2h 03m": how long a turn has run. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (minutes < 60) return `${minutes}m ${pad(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
}

export interface ThreadEntriesOptions {
  /** The thread's scope before the journal names it, as for a draft being sent. */
  scope?: string | undefined;
  /** A message this window sent, shown at once until the journal holds it. */
  pending?: PendingSend | undefined;
}

/** The thread's journal as timeline rows, whether a turn is still running, and what it is doing. */
export function threadEntries(
  events: readonly ThreadWireEvent[],
  models: readonly ModelOption[],
  options: ThreadEntriesOptions = {},
): { entries: TimelineEntry[]; running: boolean; activity?: Activity } {
  const entries: TimelineEntry[] = [];
  const calls = new Map<string, ToolCall>();
  const approvals = new Map<string, Approval>();
  let previous: { model?: string; effort?: string } | null = null;
  let running = false;
  let scope = options.scope;
  const sentAt = new Map<string, number>();
  let queued: { id: string; at: number } | null = null;
  let turn: RunningTurn | null = null;
  let setup: SetupStep | null = null;
  const endSetup = () => {
    if (!turn) return;
    turn.preparing = false;
    if (setup) entries.splice(entries.indexOf(setup), 1);
    setup = null;
  };
  const replace = (call: ToolCall, next: Partial<ToolCall>) => {
    const at = entries.indexOf(call);
    const updated = { ...call, ...next };
    entries[at] = updated;
    calls.set(call.id, updated);
  };
  const replaceApproval = (approval: Approval, next: Partial<Approval>) => {
    const at = entries.indexOf(approval);
    const updated = { ...approval, ...next };
    entries[at] = updated;
    approvals.set(approval.id, updated);
  };
  for (const event of events) {
    switch (event.type) {
      case "thread.created":
        scope = event.thread.scope;
        break;
      case "message.sent": {
        const { model, reasoningEffort: effort } = event.message;
        if (previous && (previous.model !== model || previous.effort !== effort))
          entries.push({
            kind: "model-switch",
            id: `model:${event.messageId}`,
            to: modelLine(models, model, effort),
          });
        previous = { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
        const chips = chipLabels((event.message.attachments ?? []).map(({ name }) => name));
        sentAt.set(event.messageId, event.at);
        queued = { id: event.messageId, at: event.at };
        entries.push({
          kind: "user",
          id: event.messageId,
          text: event.message.prompt,
          ...(chips.length ? { chips } : {}),
        });
        break;
      }
      case "message.cancelled":
        if (queued?.id === event.messageId) queued = null;
        entries.push({
          kind: "turn-end",
          id: `cancelled:${event.messageId}`,
          state: "cancelled",
          detail: CANCELLED[event.reason] ?? "Not run.",
        });
        break;
      case "turn.started":
        running = true;
        if (queued?.id === event.messageId) queued = null;
        turn = {
          id: event.turnId,
          since: sentAt.get(event.messageId) ?? event.at,
          preparing: false,
          tools: new Map(),
          approvals: new Set(),
        };
        break;
      case "workspace.started":
        if (turn?.id !== event.turnId || turn.preparing) break;
        turn.preparing = true;
        setup = {
          kind: "setup",
          id: `setup:${event.turnId}`,
          label: scope ? `Getting ${scopeLabel(scope)} ready` : "Getting ready",
          status: "running",
        };
        entries.push(setup);
        break;
      case "workspace.finished":
        if (turn?.id === event.turnId) endSetup();
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
        if (turn?.id === event.turnId)
          turn.tools.set(event.callId, toolPhase(event.name, event.kind, event.arguments));
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
        turn?.tools.delete(event.callId);
        const call = calls.get(event.callId);
        if (call)
          replace(call, {
            status: event.outcome === "completed" ? "done" : "failed",
            result: json(event.result),
          });
        break;
      }
      case "tool.cancelled": {
        turn?.tools.delete(event.callId);
        const call = calls.get(event.callId);
        if (call) replace(call, { status: "unknown", result: ENDED[event.reason] ?? "Ended." });
        break;
      }
      case "approval.requested": {
        if (turn?.id === event.turnId) turn.approvals.add(event.approvalId);
        if (event.asked === false && !event.reason) break;
        const approval: Approval = {
          kind: "approval",
          id: event.approvalId,
          approvalId: event.approvalId,
          turnId: event.turnId,
          requestKind: event.kind,
          status: event.asked === false ? "refused" : "pending",
          detail: event.detail,
          ...(event.path ? { path: event.path } : {}),
          ...(event.diff ? { diff: event.diff } : {}),
          ...(event.reason ? { reason: event.reason } : {}),
        };
        entries.push(approval);
        approvals.set(approval.id, approval);
        break;
      }
      case "approval.resolved": {
        turn?.approvals.delete(event.approvalId);
        const approval = approvals.get(event.approvalId);
        if (approval)
          replaceApproval(approval, {
            status: event.approved ? "approved" : approval.reason ? "refused" : "declined",
          });
        break;
      }
      case "approval.cancelled": {
        turn?.approvals.delete(event.approvalId);
        const approval = approvals.get(event.approvalId);
        if (approval)
          replaceApproval(approval, {
            status: "cancelled",
            reason:
              event.reason === "restart"
                ? "SPI Code restarted before the edit was approved. The edit was not applied."
                : event.reason === "shutdown"
                  ? "SPI Code quit before the edit was approved. The edit was not applied."
                  : "The approval ended before the edit was applied.",
          });
        break;
      }
      case "turn.finished": {
        running = false;
        const since = turn?.id === event.turnId ? turn.since : undefined;
        endSetup();
        turn = null;
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
        else if (event.outcome === "stopped" && event.reason === "operator")
          entries.push({
            kind: "turn-end",
            id: `end:${event.turnId}`,
            state: "stopped",
            ...(since === undefined ? {} : { detail: `after ${elapsed(event.at - since)}` }),
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
    if (turn && "turnId" in event && event.turnId === turn.id) turn.last = event.type;
  }

  const { pending } = options;
  const echo =
    pending &&
    !events.some((event) => event.type === "message.sent" && event.sequence > pending.after)
      ? pending
      : undefined;
  if (echo) {
    const chips = chipLabels(echo.attachments ?? []);
    entries.push({
      kind: "user",
      id: "pending",
      text: echo.prompt,
      ...(chips.length ? { chips } : {}),
    });
  }

  const waiting = echo ?? queued;
  const phase = turn ? turnPhase(turn, scope) : undefined;
  const activity: Activity | undefined = turn
    ? { since: turn.since, ...(phase ? { phase } : {}) }
    : waiting
      ? { since: waiting.at, phase: "Waiting to start" }
      : undefined;
  return { entries, running, ...(activity ? { activity } : {}) };
}
