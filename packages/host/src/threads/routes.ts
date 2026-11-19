// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION, ThreadEventSchema } from "@spi-code/contracts";
import type { HostRoutes } from "../process/port.js";
import { openThreadHost, type ThreadHostOptions } from "./wiring.js";

export class ThreadRoutes {
  private host: ReturnType<typeof openThreadHost> | undefined;
  private readonly subscriptions = new Map<string, () => void>();
  private readonly known = new Set<string>();

  constructor(private readonly options: ThreadHostOptions) {}

  private engine() {
    if (!this.host) {
      this.host = openThreadHost(this.options);
      for (const token of this.known) this.host.remember(token);
      this.known.clear();
    }
    return this.host.engine;
  }

  remember(token: string) {
    if (this.host) this.host.remember(token);
    else this.known.add(token);
  }

  readonly routes: HostRoutes = {
    "threads.list": (request, send) => {
      send({
        version: PROTOCOL_VERSION,
        id: request.id,
        kind: "response",
        type: "threads.result",
        payload: { threads: this.engine().list() },
      });
    },
    "thread.start": (request, send) => {
      if (request.type !== "thread.start") return;
      const { scope, title } = request.payload;
      if (!this.options.scopes.lookup(scope)?.canStart)
        throw new Error("Thread scope is unavailable.");
      send({
        version: PROTOCOL_VERSION,
        id: request.id,
        kind: "response",
        type: "thread.started",
        payload: {
          threadId: this.engine().create({ scope, ...(title === undefined ? {} : { title }) }),
        },
      });
    },
    "thread.send": async (request, send) => {
      if (request.type !== "thread.send") return;
      const { threadId, message } = request.payload;
      const engine = this.engine();
      const previous = engine.read(threadId).messages.at(-1)?.message;
      const model = message.model ?? previous?.model ?? "auto";
      const effort =
        message.reasoningEffort ??
        (model === previous?.model ? previous.reasoningEffort : undefined);
      const outcome = await engine.send(threadId, {
        prompt: message.prompt,
        model,
        ...(message.attachments ? { attachments: message.attachments } : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
      });
      send({
        version: PROTOCOL_VERSION,
        id: request.id,
        kind: "response",
        type: "thread.sent",
        payload: { threadId, outcome },
      });
    },
    "thread.stop": async (request, send) => {
      if (request.type !== "thread.stop") return;
      await this.engine().stop(request.payload.threadId);
      send({
        version: PROTOCOL_VERSION,
        id: request.id,
        kind: "response",
        type: "thread.stopped",
        payload: request.payload,
      });
    },
    "thread.subscribe": (request, send) => {
      if (request.type !== "thread.subscribe") return;
      const { threadId, fromSequence } = request.payload;
      const unsubscribe = this.engine().subscribe(threadId, fromSequence, {
        send: (events) =>
          send({
            version: PROTOCOL_VERSION,
            id: request.id,
            kind: "event",
            type: "thread.events",
            payload: { threadId, events: events.map((event) => ThreadEventSchema.parse(event)) },
          }),
      });
      this.subscriptions.get(threadId)?.();
      this.subscriptions.set(threadId, unsubscribe);
    },
  };

  disconnect() {
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
  }

  async stop() {
    this.disconnect();
    await this.host?.stop();
  }
}
