// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Message } from "@spi-code/contracts";

export function settleTurn(activeId: string | undefined, message: Message): string | undefined {
  return message.id === activeId && (message.type === "turn.end" || message.type === "error")
    ? undefined
    : activeId;
}

export function signInStatus(
  payload: Extract<Message, { type: "signin.state" }>["payload"],
): string {
  return payload.mode === "stub"
    ? "Stub model (no Copilot seat)"
    : payload.signedIn
      ? "Signed in through gh"
      : "Not signed in";
}
