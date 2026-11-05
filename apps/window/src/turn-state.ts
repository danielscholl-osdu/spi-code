// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Message } from "@spi-code/contracts";

export function turnInterruption(
  activeId: string | undefined,
  message: Message,
  previousHostPid?: number,
): string | undefined {
  if (activeId === undefined) return;
  if (message.type === "host.hello" && message.payload.pid !== previousHostPid)
    return "Turn failed: host restarted. Send again.";
  if (message.type === "error" && message.payload.code === "host_unavailable")
    return "Turn failed: host unavailable. Restart SPI Code to reconnect.";
}

export function settleTurn(
  activeId: string | undefined,
  message: Message,
  previousHostPid?: number,
): string | undefined {
  if (turnInterruption(activeId, message, previousHostPid)) return;
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
