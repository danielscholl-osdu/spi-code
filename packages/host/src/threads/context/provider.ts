// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type {
  ContextProvider,
  ThreadContext,
  ToolOutputRedactor,
  TurnRequest,
} from "@spi-code/threads";
import type { Scope } from "../../scopes/registry.js";
import { type OfferedTool, scopeInstructions } from "./instructions.js";

export interface ThreadContextOptions {
  readonly scopes: { lookup(id: string): Scope | undefined; list(): readonly Scope[] };
  readonly tools: readonly OfferedTool[];
  readonly redactor: Pick<ToolOutputRedactor, "text">;
}

/** The engine's context seam: scope instructions, and the chips the message snapshotted when sent. */
export function threadContext({ scopes, tools, redactor }: ThreadContextOptions) {
  return {
    prepare({ thread, message }: Pick<TurnRequest, "thread" | "message">): ThreadContext {
      const scope = scopes.lookup(thread.scope);
      if (!scope) throw new Error(`No scope ${thread.scope}.`);
      return {
        instructions: scopeInstructions(scope, scopes.list(), tools),
        attachments: (message.attachments ?? []).map(({ name, content }) => ({
          name: redactor.text(name),
          content: redactor.text(content),
        })),
      };
    },
  } satisfies ContextProvider;
}
