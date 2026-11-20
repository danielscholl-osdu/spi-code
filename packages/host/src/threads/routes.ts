// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Message, PROTOCOL_VERSION, ThreadEventSchema } from "@spi-code/contracts";
import type { HostRoutes } from "../process/port.js";
import type { ChipOutcome } from "./context/chip.js";
import { CHIP_ATTACHMENT_PREFIX, snapshotChips } from "./context/draft.js";
import { openThreadHost, type ThreadHostOptions } from "./wiring.js";

type ThreadChipResult = Extract<Message, { type: "thread.chip.result" }>["payload"];
type Attachment = { name: string; content: string };

const STALE_PREVIEW =
  "What Copilot would receive changed since its preview. Check the fresh preview and send again.";

/** What a draft shows and sends: the chip as Copilot receives it, or why it was refused. */
function chipResult(id: string, packed: ChipOutcome): ThreadChipResult {
  if (!packed.ok) return { ok: false, id, reason: packed.reason };
  const snapshot = snapshotChips([packed.chip]);
  if (!snapshot.ok) return { ok: false, id, reason: snapshot.reason };
  const [attachment] = snapshot.attachments;
  if (!attachment) return { ok: false, id, reason: `${id} was not packed.` };
  const { sweptAt, trimmed, bytes } = packed.chip;
  return { ok: true, id, sweptAt, trimmed, bytes, attachment };
}

export class ThreadRoutes {
  private host: ReturnType<typeof openThreadHost> | undefined;
  private readonly subscriptions = new Map<string, () => void>();
  /** The attachment each chip id last previewed, which a send must still match byte for byte. */
  private readonly previews = new Map<string, Attachment>();
  private readonly known = new Set<string>();
  private publishThreads: (() => void) | undefined;

  constructor(private readonly options: ThreadHostOptions) {}

  private open() {
    if (!this.host) {
      this.host = openThreadHost({
        ...this.options,
        onThreadsChanged: () => this.publishThreads?.(),
      });
      for (const token of this.known) this.host.remember(token);
      this.known.clear();
    }
    return this.host;
  }

  private engine() {
    return this.open().engine;
  }

  /** Whether Copilot would receive these bytes unchanged once the send-time redactor runs. */
  private unchanged({ name, content }: Attachment) {
    const { redact } = this.open();
    return redact(name) === name && redact(content) === content;
  }

  private stale(request: { id: string }, send: (message: Message) => void) {
    send({
      version: PROTOCOL_VERSION,
      id: request.id,
      kind: "response",
      type: "error",
      payload: { code: "stale_preview", message: STALE_PREVIEW },
    });
  }

  remember(token: string) {
    if (this.host) this.host.remember(token);
    else this.known.add(token);
  }

  readonly routes: HostRoutes = {
    "threads.list": (request, send) => {
      const publish = () =>
        send({
          version: PROTOCOL_VERSION,
          id: request.id,
          kind: "response",
          type: "threads.result",
          payload: { threads: this.engine().list() },
        });
      this.publishThreads = publish;
      publish();
    },
    "thread.start": (request, send) => {
      if (request.type !== "thread.start") return;
      const { scope, title, subject } = request.payload;
      if (!this.options.scopes.lookup(scope)?.canStart)
        throw new Error("Thread scope is unavailable.");
      if (subject !== undefined) {
        const preview = this.previews.get(subject);
        if (!preview || !this.unchanged(preview)) return this.stale(request, send);
      }
      send({
        version: PROTOCOL_VERSION,
        id: request.id,
        kind: "response",
        type: "thread.started",
        payload: {
          threadId: this.engine().create({
            scope,
            ...(title === undefined ? {} : { title }),
            ...(subject === undefined ? {} : { subject }),
          }),
        },
      });
    },
    "thread.chip": async (request, send) => {
      if (request.type !== "thread.chip") return;
      const { id } = request.payload;
      const payload = chipResult(id, await this.open().chip(id));
      if (payload.ok) this.previews.set(id, payload.attachment);
      else this.previews.delete(id);
      send({
        version: PROTOCOL_VERSION,
        id: request.id,
        kind: "response",
        type: "thread.chip.result",
        payload,
      });
    },
    "thread.send": async (request, send) => {
      if (request.type !== "thread.send") return;
      const { threadId, message } = request.payload;
      const previewed = (message.attachments ?? []).filter(({ name, content }) => {
        const id = name.startsWith(CHIP_ATTACHMENT_PREFIX)
          ? name.slice(CHIP_ATTACHMENT_PREFIX.length)
          : undefined;
        return id !== undefined && this.previews.get(id)?.content === content;
      });
      if (!previewed.every((attachment) => this.unchanged(attachment)))
        return this.stale(request, send);
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
    "thread.settle": (request, send) => {
      if (request.type !== "thread.settle") return;
      if (!this.engine().settle(request.payload.threadId)) {
        send({
          version: PROTOCOL_VERSION,
          id: request.id,
          kind: "response",
          type: "error",
          payload: {
            code: "thread_busy",
            message: "A Working or Waiting on you thread cannot be settled.",
          },
        });
        return;
      }
      send({
        version: PROTOCOL_VERSION,
        id: request.id,
        kind: "response",
        type: "thread.settled",
        payload: request.payload,
      });
    },
    "thread.unsettle": (request, send) => {
      if (request.type !== "thread.unsettle") return;
      this.engine().unsettle(
        request.payload.threadId,
        request.payload.restore ? { restore: true } : {},
      );
      send({
        version: PROTOCOL_VERSION,
        id: request.id,
        kind: "response",
        type: "thread.unsettled",
        payload: { threadId: request.payload.threadId },
      });
    },
    "thread.seen": (request, send) => {
      if (request.type !== "thread.seen") return;
      this.engine().seen(request.payload.threadId, request.payload.sequence);
      send({
        version: PROTOCOL_VERSION,
        id: request.id,
        kind: "response",
        type: "thread.seen.result",
        payload: { threadId: request.payload.threadId },
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
    this.publishThreads = undefined;
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
  }

  async stop() {
    this.disconnect();
    await this.host?.stop();
  }
}
