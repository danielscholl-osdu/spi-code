// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type Message,
  type ModelCatalogResult,
  PROTOCOL_VERSION,
  parseMessage,
  ReasoningEffortSchema,
  type ThreadWireEvent,
} from "@spi-code/contracts";
import { createStore } from "zustand/vanilla";
import type { ModelChoice } from "./types.js";

type Request = Extract<Message, { kind: "request" }>;
export type ThreadSummary = Extract<
  Message,
  { type: "threads.result" }
>["payload"]["threads"][number];
export type ChipResult = Extract<Message, { type: "thread.chip.result" }>["payload"];

/** The draft's route id: a thread not yet started. */
export const NEW_THREAD = "new";

/** A row or popover a thread can be asked about: its subject, title and fork. */
export interface AskTarget {
  subject: string;
  label: string;
  /** The row's fork; absent when the row has none. */
  scope?: string;
  origin?: string;
}

export interface Draft {
  /** null is Program, which the window does not start yet. */
  scope: string | null;
  subject?: { id: string; label: string };
  origin?: string;
  chip?: { state: "packing" } | ({ state: "done" } & ChipResult);
  /** The words being sent while the host starts the thread. */
  sending?: string;
  /** Why the last send started no thread; the composer keeps the operator's words. */
  failure?: { reason: string };
}

type ThreadsState = {
  /** null until the host lists its threads. */
  threads: readonly ThreadSummary[] | null;
  /** Each subscribed thread's journal so far; a hello resubscribes every key. */
  events: Readonly<Record<string, readonly ThreadWireEvent[]>>;
  failures: Readonly<Record<string, string>>;
  catalog: ModelCatalogResult | null;
  choices: Readonly<Record<string, ModelChoice>>;
  draft: Draft | null;
  /** The row or popover open now, which ⌘N carries. */
  target: AskTarget | null;
  undo: { id: string; title: string } | null;
  setTarget(target: AskTarget | null): void;
  startDraft(scope: string | null, target?: AskTarget | null): void;
  setDraftScope(scope: string): void;
  removeDraftChip(): void;
  sendDraft(text: string, onStarted: (threadId: string) => void): void;
  send(threadId: string, text: string): void;
  stop(threadId: string): void;
  open(threadId: string): void;
  settle(thread: ThreadSummary, onSettled?: (threads: readonly ThreadSummary[]) => void): void;
  unsettle(threadId: string, options?: { restore?: boolean }): void;
  toggle(thread: ThreadSummary, onSettled?: (threads: readonly ThreadSummary[]) => void): void;
  dismissUndo(): void;
  choose(key: string, choice: ModelChoice): void;
  listModels(): void;
  receive(input: unknown): void;
};

const STATUS_EVENTS = new Set([
  "message.sent",
  "turn.started",
  "turn.finished",
  "message.cancelled",
  "thread.settled",
  "thread.unsettled",
  "thread.seen",
]);
const failed = (message: Message) =>
  message.type === "error" ? message.payload.message : undefined;

/** The model and effort a thread's last message used, which its next one keeps unless changed. */
export function lastChoice(events: readonly ThreadWireEvent[] | undefined): ModelChoice | null {
  const last = [...(events ?? [])].reverse().find((event) => event.type === "message.sent");
  if (last?.type !== "message.sent" || !last.message.model) return null;
  return {
    model: last.message.model,
    ...(last.message.reasoningEffort ? { effort: last.message.reasoningEffort } : {}),
  };
}

const withoutSending = ({ sending: _, ...draft }: Draft): Draft => draft;

/** A short title from the operator's first words. */
export function threadTitle(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  if (line.length <= 72) return line;
  const cut = line.slice(0, 72);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).trimEnd()}…`;
}

/** Requests a hello makes again, so one posted before the port arrived is not held for it. */
const REDONE_AT_HELLO = new Set<Request["type"]>([
  "threads.list",
  "thread.subscribe",
  "thread.chip",
]);
/** The thread.start refusal that means the chip's preview is no longer what Copilot would get. */
const STALE_PREVIEW = "stale_preview";

export function createThreadStore(post: (message: Message) => void = postToHost) {
  const waiting = new Map<string, (message: Message) => void>();
  /** Requests made before the host port arrived, posted after the next hello. */
  let held: { message: Message; then?: (message: Message) => void }[] = [];
  const deliver = (message: Message, then?: (message: Message) => void) => {
    if (then) waiting.set(message.id, then);
    try {
      post(message);
    } catch {
      waiting.delete(message.id);
      held.push({ message, ...(then ? { then } : {}) });
    }
  };
  const request = (
    type: Request["type"],
    payload: Request["payload"],
    then?: (message: Message) => void,
  ) => {
    const id = crypto.randomUUID();
    const parsed = parseMessage({ version: PROTOCOL_VERSION, id, kind: "request", type, payload });
    if (!parsed.ok) throw new Error(`Window generated an invalid ${type}`);
    deliver(parsed.message, then);
  };

  return createStore<ThreadsState>()((set, get) => {
    const list = (onListed?: (threads: readonly ThreadSummary[]) => void) =>
      request("threads.list", {}, (reply) => {
        if (reply.type !== "threads.result") {
          set({ threads: null });
          return;
        }
        onListed?.(reply.payload.threads);
      });
    const subscribe = (threadId: string) => {
      const fromSequence = get().events[threadId]?.at(-1)?.sequence ?? 0;
      request("thread.subscribe", { threadId, fromSequence });
    };
    const message = (
      threadId: string,
      text: string,
      attachment?: { name: string; content: string },
    ) => {
      const choice = get().choices[threadId] ?? lastChoice(get().events[threadId]);
      return {
        prompt: text,
        ...(attachment ? { attachments: [attachment] } : {}),
        ...(choice ? { model: choice.model } : {}),
        ...(choice?.effort && ReasoningEffortSchema.safeParse(choice.effort).success
          ? { reasoningEffort: choice.effort }
          : {}),
      } as Extract<Request, { type: "thread.send" }>["payload"]["message"];
    };
    const sendMessage = (threadId: string, payload: ReturnType<typeof message>) => {
      set(({ failures }) => {
        const { [threadId]: _, ...rest } = failures;
        return { failures: rest };
      });
      request("thread.send", { threadId, message: payload }, (reply) => {
        const reason = failed(reply);
        if (reason) set(({ failures }) => ({ failures: { ...failures, [threadId]: reason } }));
        list();
      });
    };
    const pack = (subject: string) =>
      request("thread.chip", { id: subject }, (reply) => {
        const { draft } = get();
        if (draft?.subject?.id !== subject) return;
        const chip =
          reply.type === "thread.chip.result"
            ? ({ state: "done", ...reply.payload } as const)
            : ({
                state: "done",
                ok: false,
                id: subject,
                reason: failed(reply) ?? "The host did not pack it.",
              } as const);
        set({ draft: { ...draft, chip } });
      });

    /** The host went away: its threads are not known, and what it was doing ends or starts again. */
    const lose = (gone: string | null) => {
      const { draft } = get();
      let next = draft;
      if (next?.sending !== undefined) {
        const reason = gone ?? "The host restarted before the thread started.";
        next = { ...withoutSending(next), failure: { reason } };
      }
      if (gone && next?.chip?.state === "packing" && next.subject)
        next = { ...next, chip: { state: "done", ok: false, id: next.subject.id, reason: gone } };
      set({ threads: null, ...(next === draft ? {} : { draft: next }) });
      if (next?.chip?.state === "packing" && next.subject) pack(next.subject.id);
    };

    return {
      threads: null,
      events: {},
      failures: {},
      catalog: null,
      choices: {},
      draft: null,
      target: null,
      undo: null,
      setTarget: (target) => set({ target }),
      startDraft(scope, target) {
        const draft: Draft = {
          scope,
          ...(target ? { subject: { id: target.subject, label: target.label } } : {}),
          ...(target?.origin ? { origin: target.origin } : {}),
          ...(target ? { chip: { state: "packing" } as const } : {}),
        };
        set(({ choices }) => {
          const { draft: _, ...rest } = choices;
          return { draft, choices: rest };
        });
        if (target) pack(target.subject);
        if (!get().catalog) get().listModels();
      },
      setDraftScope(scope) {
        const { draft } = get();
        if (draft) set({ draft: { ...draft, scope } });
      },
      removeDraftChip() {
        const { draft } = get();
        if (!draft) return;
        const { chip: _, subject: __, ...rest } = draft;
        set({ draft: rest });
      },
      sendDraft(text, onStarted) {
        const { draft } = get();
        if (!draft?.scope || draft.sending !== undefined || draft.chip?.state === "packing") return;
        const choice = get().choices.draft;
        const chip = draft.chip?.state === "done" && draft.chip.ok ? draft.chip : undefined;
        const { failure: _, ...rest } = draft;
        set({ draft: { ...rest, sending: text } });
        const definition = {
          scope: draft.scope,
          title: threadTitle(text),
          ...(draft.subject && chip ? { subject: draft.subject.id } : {}),
        };
        request("thread.start", definition, (reply) => {
          const current = get().draft;
          if (reply.type !== "thread.started") {
            const stale =
              reply.type === "error" && reply.payload.code === STALE_PREVIEW && current?.subject;
            if (current)
              set({
                draft: {
                  ...withoutSending(current),
                  ...(stale ? { chip: { state: "packing" } as const } : {}),
                  failure: { reason: failed(reply) ?? "The thread did not start." },
                },
              });
            if (stale) pack(stale.id);
            return;
          }
          const { threadId } = reply.payload;
          if (choice) set(({ choices }) => ({ choices: { ...choices, [threadId]: choice } }));
          const payload = message(threadId, text, chip?.attachment);
          onStarted(threadId);
          set({ draft: null, events: { ...get().events, [threadId]: [] } });
          subscribe(threadId);
          sendMessage(threadId, payload);
        });
      },
      send: (threadId, text) => sendMessage(threadId, message(threadId, text)),
      stop: (threadId) => request("thread.stop", { threadId }, () => list()),
      open(threadId) {
        if (!get().catalog) get().listModels();
        const summary = get().threads?.find((thread) => thread.id === threadId);
        if (summary?.status === "Can't be read") return;
        const sequence = Math.max(
          summary?.sequence ?? 0,
          get().events[threadId]?.at(-1)?.sequence ?? 0,
        );
        request("thread.seen", { threadId, sequence });
        if (get().events[threadId]) return;
        set(({ events }) => ({ events: { ...events, [threadId]: [] } }));
        subscribe(threadId);
      },
      settle(thread, onSettled) {
        request("thread.settle", { threadId: thread.id }, (reply) => {
          const reason = failed(reply);
          if (reason) {
            set(({ failures }) => ({ failures: { ...failures, [thread.id]: reason } }));
            return;
          }
          set({ undo: { id: thread.id, title: thread.thread.title ?? "Untitled thread" } });
          list(onSettled);
        });
      },
      unsettle(threadId, options = {}) {
        request(
          "thread.unsettle",
          { threadId, ...(options.restore ? { restore: true as const } : {}) },
          (reply) => {
            const reason = failed(reply);
            if (reason) {
              set(({ failures }) => ({ failures: { ...failures, [threadId]: reason } }));
              return;
            }
            set((state) => ({ undo: state.undo?.id === threadId ? null : state.undo }));
            list();
          },
        );
      },
      toggle(thread, onSettled) {
        if (thread.status === "Settled") get().unsettle(thread.id);
        else get().settle(thread, onSettled);
      },
      dismissUndo: () => set({ undo: null }),
      choose: (key, choice) => set(({ choices }) => ({ choices: { ...choices, [key]: choice } })),
      listModels: () => request("models.list", {}),
      receive(input) {
        const parsed = parseMessage(input);
        if (!parsed.ok) return;
        const reply = parsed.message;
        if (reply.kind === "request") return;
        if (reply.type === "host.hello") {
          const queued = held;
          held = [];
          waiting.clear();
          lose(null);
          list();
          for (const threadId of Object.keys(get().events)) subscribe(threadId);
          for (const { message, then } of queued)
            if (!REDONE_AT_HELLO.has(message.type as Request["type"])) deliver(message, then);
          return;
        }
        if (reply.type === "error" && reply.payload.code === "host_unavailable") {
          waiting.clear();
          lose(reply.payload.message);
          return;
        }
        const then = waiting.get(reply.id);
        if (then && reply.kind === "response") {
          waiting.delete(reply.id);
          then(reply);
        }
        if (reply.type === "threads.result") set({ threads: reply.payload.threads });
        else if (reply.type === "models.result") set({ catalog: reply.payload });
        else if (reply.type === "thread.events") {
          const { threadId, events } = reply.payload;
          const known = get().events[threadId] ?? [];
          const after = known.at(-1)?.sequence ?? 0;
          const fresh = events.filter(({ sequence }) => sequence > after);
          if (fresh.length === 0) return;
          set(({ events: all }) => ({ events: { ...all, [threadId]: [...known, ...fresh] } }));
          if (fresh.some(({ type }) => STATUS_EVENTS.has(type))) list();
        }
      },
    };
  });
}

function postToHost(message: Message) {
  window.spi?.postMessage(message);
}

export const threadStore = createThreadStore();
