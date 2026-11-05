// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Message, PROTOCOL_VERSION, parseMessage } from "@spi-code/contracts";

declare global {
  interface Window {
    spi: {
      postMessage(message: Message): void;
      onMessage(listener: (message: unknown) => void): () => void;
    };
  }
}

const status = document.getElementById("status");
function send(message: Message): void {
  const parsed = parseMessage(message);
  if (!parsed.ok) throw new Error("Window generated an invalid message");
  window.spi.postMessage(parsed.message);
}

window.spi.onMessage((input) => {
  const parsed = parseMessage(input);
  if (!parsed.ok) {
    send({
      version: PROTOCOL_VERSION,
      id: "invalid",
      kind: "response",
      type: "error",
      payload: { code: "invalid_message", message: "Host message failed contract validation" },
    });
    if (status) status.textContent = "Invalid host message rejected";
    return;
  }
  const message = parsed.message;
  if (message.type === "host.hello") {
    send({
      version: PROTOCOL_VERSION,
      id: "window-ping",
      kind: "request",
      type: "ping",
      payload: {},
    });
  } else if (message.type === "pong") {
    if (status) status.textContent = "Host connected";
  } else if (message.type === "error" && status) {
    status.textContent = message.payload.message;
  }
});
