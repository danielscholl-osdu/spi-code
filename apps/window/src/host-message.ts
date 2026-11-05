// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Message, parseMessage } from "@spi-code/contracts";

export function hostMessageHandler(
  accept: (message: Message) => void,
  reject: () => void,
  activeRequestId: () => string | undefined,
  ownsRequestId: (id: string) => boolean = (id) => id === activeRequestId(),
): (input: unknown) => void {
  return (input) => {
    const parsed = parseMessage(input);
    if (!parsed.ok || parsed.message.kind === "request") {
      reject();
      return;
    }
    if (
      (parsed.message.type === "turn.delta" || parsed.message.type === "tool.call") &&
      parsed.message.id !== activeRequestId()
    )
      return;
    if (parsed.message.type === "error" && !ownsRequestId(parsed.message.id)) return;
    accept(parsed.message);
  };
}
