// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { JournalOutputRedactor } from "./redaction.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | {
      readonly [key: string]: JsonValue;
    };

export interface ThreadDefinition {
  scope: string;
  title?: string;
  /** The item the thread started from. */
  subject?: string;
}

export interface ThreadAttachment {
  name: string;
  content: string;
}

export interface ThreadMessage {
  prompt: string;
  attachments?: readonly ThreadAttachment[];
  model?: string;
  reasoningEffort?: string;
}

export interface TurnRequest {
  threadId: string;
  thread: Readonly<ThreadDefinition>;
  turnId: string;
  message: Readonly<ThreadMessage>;
  signal: AbortSignal;
}

export interface ThreadWorkspace {
  cwd: string;
}

export interface ThreadContext {
  instructions: string;
  attachments: readonly ThreadAttachment[];
}

type Prepared<T> = T | Promise<T>;
export interface WorkspaceProvider {
  resolve(request: TurnRequest): Prepared<ThreadWorkspace>;
}
export interface ContextProvider {
  prepare(request: TurnRequest): Prepared<ThreadContext>;
}
export interface ToolProvider<Tool> {
  offer(request: TurnRequest, workspace: ThreadWorkspace): Prepared<readonly Tool[]>;
}
export interface ThreadTransport {
  send(events: readonly ThreadEvent[]): void;
}

export interface RuntimeTurn<Tool> extends TurnRequest {
  workspace: ThreadWorkspace;
  context: ThreadContext;
  tools: readonly Tool[];
}

export interface ToolStart {
  callId: string;
  name: string;
  kind: "command" | "tool";
  arguments: JsonValue;
}

export interface ToolResult {
  callId: string;
  outcome: "completed" | "failed";
  result: JsonValue;
}

/** A runtime can submit ordered raw text chunks instead of a complete structured result. */
export type ToolCompletion =
  | ToolResult
  | (Omit<ToolResult, "result"> & {
      resultChunks: Iterable<string>;
    });

export interface ApprovalRequest {
  approvalId: string;
  kind: string;
  detail: string;
}

export interface RuntimeEvents {
  delta(text: string): void;
  toolStarted(call: ToolStart): void;
  toolFinished(result: ToolCompletion): void;
  requestApproval(request: ApprovalRequest, decision?: boolean): Promise<boolean>;
}

export type RuntimeStop = { outcome: "stopped"; reason: "refused-tool" };

export interface ThreadRuntime<Tool> {
  /**
   * Run only the supplied turn. Resume sessions with pending-work continuation disabled
   * and forward only this turn's events. On abort, settle once the session can accept another turn.
   */
  run(
    input: RuntimeTurn<Tool>,
    events: RuntimeEvents,
  ): Promise<void> | Promise<RuntimeStop | undefined>;
}

export interface ThreadEngineOptions<Tool> {
  runtime: ThreadRuntime<Tool>;
  workspace: WorkspaceProvider;
  context: ContextProvider;
  tools: ToolProvider<Tool>;
  /** Supply the journal profile from createToolOutputRedactor to include host-known secrets. */
  redactor?: JournalOutputRedactor;
  onUnreadableThread?(id: string): void;
}

type InterruptionReason = "restart" | "shutdown";
type StopReason = "operator" | RuntimeStop["reason"];
type CancelReason = InterruptionReason | StopReason | "turn-ended";

type TurnEvent = { turnId: string } & (
  | { type: "turn.started"; messageId: string }
  | { type: "assistant.delta"; text: string }
  | ({ type: "tool.started" } & ToolStart)
  | ({ type: "tool.finished"; resultBytes: number; durationMs: number } & ToolResult)
  | {
      type: "tool.cancelled";
      callId: string;
      reason: CancelReason;
      durationMs: number;
      processState?: "not known";
      effectState?: "not known";
    }
  | ({ type: "approval.requested" } & ApprovalRequest)
  | { type: "approval.resolved"; approvalId: string; approved: boolean }
  | { type: "approval.cancelled"; approvalId: string; reason: CancelReason }
  | ({ type: "turn.finished"; partialTextSeen?: "not known" } & TurnEnd)
);

export type TurnEnd =
  | { outcome: "completed" }
  | { outcome: "failed"; failure?: string }
  | { outcome: "stopped"; reason: StopReason }
  | { outcome: "cancelled"; reason: InterruptionReason };
export type TurnOutcome = TurnEnd["outcome"];

export type JournalEntry =
  | { type: "thread.created"; thread: ThreadDefinition }
  | {
      type: "thread.settled";
      reason: "operator" | "inactivity";
      settledAt: number;
      held?: boolean;
    }
  | { type: "thread.unsettled"; reason: "operator"; restore?: true }
  | { type: "thread.seen"; seenSequence: number }
  | { type: "message.sent"; messageId: string; message: ThreadMessage }
  | { type: "message.cancelled"; messageId: string; reason: InterruptionReason }
  | TurnEvent;

export type ThreadEvent = JournalEntry & { threadId: string; sequence: number; at: number };
export type EventOf<Type extends ThreadEvent["type"]> = Extract<ThreadEvent, { type: Type }>;

export type ThreadStatus = "Waiting on you" | "Working" | "Open" | "Settled" | "Can't be read";

export interface TimelineMessage {
  id: string;
  message: Readonly<ThreadMessage>;
  status: "queued" | "started" | "cancelled";
}

export interface TimelineTurn {
  id: string;
  messageId: string;
  text: string;
  outcome: "running" | TurnOutcome;
  stopReason?: StopReason;
  failure?: string;
  partialTextSeen?: "not known";
  tools: TimelineTool[];
  approvals: TimelineApproval[];
}

export interface TimelineTool {
  start: EventOf<"tool.started">;
  end?: EventOf<"tool.finished" | "tool.cancelled">;
}

export interface TimelineApproval {
  request: EventOf<"approval.requested">;
  end?: EventOf<"approval.resolved" | "approval.cancelled">;
}

export interface ThreadSummary {
  id: string;
  thread: ThreadDefinition;
  status: ThreadStatus;
  sequence: number;
  updatedAt: number;
  settledAt: number | null;
  done: boolean;
}

export interface ThreadTimeline extends ThreadSummary {
  messages: TimelineMessage[];
  turns: TimelineTurn[];
}
