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

export type HostSend = (message: Message) => void;
export type HostRoute = ((message: Message, send: HostSend) => void | Promise<void>) & {
  serial?: boolean;
};
export type HostRoutes = Partial<Record<Message["type"], HostRoute>>;

export function attachHostPort(
  port: HostPort,
  pid: number,
  routes: HostRoutes = {},
  queue: HostRequestQueue = { pending: Promise.resolve() },
): () => void {
  let stopped = false;
  const send = (message: Message) => {
    const parsed = parseMessage(message);
    if (!parsed.ok) throw new Error("Host generated an invalid message");
    port.postMessage(parsed.message);
  };
  const failed = (id: string) => {
    try {
      send({
        version: PROTOCOL_VERSION,
        id,
        kind: "response",
        type: "error",
        payload: { code: "host_failed", message: "Host request failed" },
      });
    } catch {
      console.error("Host request failure response could not be sent");
    }
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
    if (stopped) {
      failed(message.id);
      return;
    }
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
    const route = Object.hasOwn(routes, message.type) ? routes[message.type] : undefined;
    if (route) {
      const run = () => {
        if (stopped) throw new Error("Host port is stopped");
        return route(message, send);
      };
      if (route.serial) {
        queue.pending = queue.pending.then(run).catch(() => failed(message.id));
      } else {
        void Promise.resolve()
          .then(run)
          .catch(() => failed(message.id));
      }
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
  return () => {
    stopped = true;
  };
}
