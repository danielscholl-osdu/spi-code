// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Message, PROTOCOL_VERSION, parseMessage } from "@spi-code/contracts";

export interface HostPort {
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  postMessage(message: unknown): void;
  start(): void;
}

export interface HostRequestQueue {
  pending: Promise<void>;
}

export function attachHostPort(
  port: HostPort,
  pid: number,
  handler?: (message: Message, send: (message: Message) => void) => Promise<void>,
  queue: HostRequestQueue = { pending: Promise.resolve() },
): void {
  const send = (message: Message) => {
    const parsed = parseMessage(message);
    if (!parsed.ok) throw new Error("Host generated an invalid message");
    port.postMessage(parsed.message);
  };
  port.on("message", ({ data }) => {
    const parsed = parseMessage(data);
    if (!parsed.ok) {
      send({
        version: PROTOCOL_VERSION,
        id: "invalid",
        kind: "response",
        type: "error",
        payload: { code: "invalid_message", message: "Message failed contract validation" },
      });
      return;
    }
    const message = parsed.message;
    if (message.kind !== "request") return;
    if (message.type === "ping") {
      send({
        version: PROTOCOL_VERSION,
        id: message.id,
        kind: "response",
        type: "pong",
        payload: {},
      });
      return;
    }
    if (handler && (message.type === "models.list" || message.type === "turn.start")) {
      queue.pending = queue.pending
        .then(() => handler(message, send))
        .catch(() =>
          send({
            version: PROTOCOL_VERSION,
            id: message.id,
            kind: "response",
            type: "error",
            payload: { code: "host_failed", message: "Host request failed" },
          }),
        );
      return;
    }
    send({
      version: PROTOCOL_VERSION,
      id: message.id,
      kind: "response",
      type: "error",
      payload: { code: "unsupported_message", message: "Host does not handle this message yet" },
    });
  });
  port.start();
  send({
    version: PROTOCOL_VERSION,
    id: "hello",
    kind: "event",
    type: "host.hello",
    payload: { pid },
  });
}
