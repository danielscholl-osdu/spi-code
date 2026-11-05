// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Message, parseMessage } from "@spi-code/contracts";

export function hostMessageHandler(
  accept: (message: Message) => void,
  reject: () => void,
): (input: unknown) => void {
  return (input) => {
    const parsed = parseMessage(input);
    if (!parsed.ok || parsed.message.kind === "request") {
      reject();
      return;
    }
    accept(parsed.message);
  };
}
