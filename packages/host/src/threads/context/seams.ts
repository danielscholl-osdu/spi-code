// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

// Structurally the @spi-code/threads seams this module fills; the host's thread wiring passes them on.
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface ThreadAttachment {
  name: string;
  content: string;
}

export interface ContextTurn {
  thread: Readonly<{ scope: string }>;
  message: Readonly<{ attachments?: readonly ThreadAttachment[] }>;
}

export interface ThreadContext {
  instructions: string;
  attachments: readonly ThreadAttachment[];
}

/** The threads package's model profile: what a tool result or chip is reduced to before Copilot. */
export interface ModelRedactor {
  text(output: string): string;
  value(output: JsonValue): JsonValue;
}
