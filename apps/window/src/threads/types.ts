// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ReactNode } from "react";
import type { IconName } from "../components/icons/Icon.js";

/** How a call or a setup step ended. `unknown` is a step whose end the host never saw. */
export type StepStatus = "running" | "done" | "failed" | "unknown";

export interface UserMessage {
  kind: "user";
  id: string;
  text: string;
  /** Context chips sent with the message, as their labels. */
  chips?: readonly string[];
}

export interface AssistantMessage {
  kind: "assistant";
  id: string;
  /** Markdown. */
  text: string;
  streaming?: boolean;
}

export interface ToolCall {
  kind: "call";
  id: string;
  /** What the call did, in a line ("Read spi_inspect", "Ran mvn -q test"). */
  label: string;
  status: StepStatus;
  /** The call's arguments as the host recorded them. */
  args?: string;
  /** The call's result or error output, already redacted by the host. */
  result?: string;
}

export interface SetupStep {
  kind: "setup";
  id: string;
  /** "Cloned Azure/osdu-spi-partition", "Made a worktree on spi/blob-retry". */
  label: string;
  status: StepStatus;
  detail?: string;
}

export interface TurnEnd {
  kind: "turn-end";
  id: string;
  /** `unknown`: the host lost the turn and cannot say how it ended. */
  state: "cancelled" | "failed" | "unknown";
  detail?: string;
}

export interface Approval {
  kind: "approval";
  id: string;
  approvalId: string;
  turnId: string;
  requestKind: string;
  status: "pending" | "approved" | "declined" | "cancelled";
  detail: string;
  path?: string;
  diff?: string;
  reason?: string;
}

export interface ModelSwitch {
  kind: "model-switch";
  id: string;
  /** The model and effort it switched to, as the chip reads ("Opus 5.5 · High"). */
  to: string;
}

export type TimelineEntry =
  | UserMessage
  | AssistantMessage
  | ToolCall
  | SetupStep
  | TurnEnd
  | Approval
  | ModelSwitch;

export interface ContextChip {
  id: string;
  label: string;
  /** The packed context Copilot receives, shown when the chip is opened. */
  preview: string;
}

export interface PlaceOption {
  id: string;
  label: string;
  detail?: string;
}

export interface ScopeOption {
  id: string;
  label: string;
  /** Its sidebar icon. */
  icon?: IconName;
}

export interface ModelOption {
  id: string;
  name: string;
  /** Premium-request multiplier from `billing.multiplier`. */
  multiplier?: number;
  favourite?: boolean;
  /** From `policy.state`; a model not enabled is shown greyed and cannot be chosen. */
  policy: "enabled" | "disabled" | "unconfigured" | "not known";
  reasoningEfforts?: readonly string[];
  defaultReasoningEffort?: string;
}

export interface ModelChoice {
  /** `auto` or a model id. */
  model: string;
  effort?: string;
}

export interface CopilotAccount {
  login: string;
  /** Share of premium requests used, 0 to 100, when Copilot reports a quota. */
  usedPercent?: number;
}

export interface ComposerProps {
  scope: ScopeOption;
  context: readonly ContextChip[];
  onRemoveContext(id: string): void;
  places: readonly PlaceOption[];
  models: readonly ModelOption[];
  choice: ModelChoice;
  onChoose(choice: ModelChoice): void;
  account?: CopilotAccount;
  onRefreshModels?(): void;
  onOpenLink?(url: string): void;
  running: boolean;
  draft: boolean;
  /** Why the message cannot go yet, or why the last send failed. A draft keeps its words on send. */
  notice?: string | undefined;
  /** False holds send, as while a chip is packing or no scope can start. */
  canSend?: boolean;
  onSend(message: { text: string; places: readonly PlaceOption[] }): void;
  onStop(): void;
}

export interface ThreadViewProps extends ComposerProps {
  entries: readonly TimelineEntry[];
  /** The first context's line: scope, sweep time and size ("Context · partition · from the sweep at 13:50 · 1 item"). */
  contextLine?: string | undefined;
  /** A draft's scope control, which opens the scope picker; once sent the scope is fixed. */
  onChangeScope?(): void;
  /** What a draft shows under its composer. */
  below?: ReactNode;
  onApprovalDecision?(approval: Approval, approved: boolean): void;
}
