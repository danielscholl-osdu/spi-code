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
import type { Route } from "../app/navigation.js";
import type { PendingSend } from "./entries.js";
import type { LandsInChoice } from "./LandsInChip.js";
import { PLACE_SCOPES } from "./scopes.js";
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
  /** The thread this target is the finding of, which a thread started from it continues. */
  parent?: string;
}

/** Where a draft was opened from, which its back link returns to. */
export interface DraftFrom {
  label: string;
  route: Route;
}

export interface Draft {
  scope: string;
  /** Bumped by each new draft, so its composer starts afresh with the draft's words. */
  opened?: number;
  /** The words the draft opens with, as a sentence asked from Find. */
  text?: string;
  /** The thread this draft continues, whose finding must be its chip. */
  parent?: string;
  /** Where the draft's work lands; absent is Asking. */
  landsIn?: LandsInChoice;
  from?: DraftFrom;
  subject?: { id: string; label: string };
  origin?: string;
  chip?: { state: "packing" } | ({ state: "done" } & ChipResult);
  /** The message on its way while the host starts the thread, and the words the operator typed. */
  sending?: { words: string; message: PendingSend; stopping?: true };
  /** Why the last send started no thread, and the words to put back in the composer. */
  failure?: { reason: string; words?: string };
}

type ThreadsState = {
  /** null until the host lists its threads. */
  threads: readonly ThreadSummary[] | null;
  /** Each subscribed thread's journal so far; a hello resubscribes every key. */
  events: Readonly<Record<string, readonly ThreadWireEvent[]>>;
  failures: Readonly<Record<string, string>>;
  /** Messages sent from this window whose turn has not ended. */
  pending: Readonly<Record<string, PendingSend>>;
  /** Threads whose Stop was pressed and whose turn has not ended. */
  stopping: Readonly<Record<string, true>>;
  /** The host's last list, which `threads` shows with what this window knows sooner. */
  listed: readonly ThreadSummary[] | null;
  /** Threads the host started for this window that its list does not hold yet. */
  started: Readonly<Record<string, ThreadSummary>>;
  catalog: ModelCatalogResult | null;
  choices: Readonly<Record<string, ModelChoice>>;
  draft: Draft | null;
  /** The row or popover open now, which ⌘N carries. */
  target: AskTarget | null;
  undo: { id: string; title: string } | null;
  setTarget(target: AskTarget | null): void;
  startDraft(
    scope: string,
    target?: AskTarget | null,
    from?: DraftFrom,
    text?: string,
    landsIn?: Draft["landsIn"],
  ): void;
  setDraftScope(scope: string): void;
  setDraftLandsIn(choice: LandsInChoice): void;
  /** Attaches a row as the draft's one chip, in place of any chip there. */
  attachDraftChip(target: AskTarget): void;
  removeDraftChip(): void;
  /** Sends the draft's first message: the words as typed, and whether it asks only about the chip. */
  sendDraft(
    send: { words: string; chipOnly: boolean },
    onStarted: (threadId: string) => void,
  ): void;
  send(threadId: string, text: string): void;
  decideApproval(threadId: string, turnId: string, approvalId: string, approved: boolean): void;
  stop(threadId: string): void;
  /** Stop pressed while the host starts the draft's thread: its turn is stopped once it begins. */
  stopDraft(): void;
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
  "approval.requested",
  "approval.resolved",
  "approval.cancelled",
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

/** What a send with a chip and no words asks; the empty composer shows it as its placeholder. */
export const CHIP_ONLY_PROMPT =
  "Look at what's attached and tell me what stands out and what I should do next.";

/** The chip a continuation must carry: its parent's last answer. */
export const findingOf = (parent: string) => `finding:${parent}`;
const landsInScope = (scope: string) => PLACE_SCOPES.some(({ id }) => id === scope);

const withoutSending = ({ sending: _, ...draft }: Draft): Draft => draft;
/** The draft as it was before a send that started no thread, its words put back. */
const failDraft = (draft: Draft, reason: string): Draft => ({
  ...withoutSending(draft),
  failure: { reason, ...(draft.sending?.words ? { words: draft.sending.words } : {}) },
});
const without = <T>(record: Readonly<Record<string, T>>, key: string) => {
  const { [key]: _, ...rest } = record;
  return rest;
};

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
  /** Requests made before the host port arrived, posted after the next hello; a start keeps its draft's serial. */
  type Held = { message: Message; then?: (message: Message) => void; serial?: number };
  let held: Held[] = [];
  const deliver = ({ message, then, serial }: Held) => {
    if (then) waiting.set(message.id, then);
    try {
      post(message);
    } catch {
      waiting.delete(message.id);
      held.push({
        message,
        ...(then ? { then } : {}),
        ...(serial === undefined ? {} : { serial }),
      });
    }
  };
  /** The drafts whose held start the next hello will post. */
  const heldStarts = () =>
    new Set(held.flatMap(({ serial }) => (serial === undefined ? [] : [serial])));
  const request = (
    type: Request["type"],
    payload: Request["payload"],
    then?: (message: Message) => void,
    serial?: number,
  ) => {
    const id = crypto.randomUUID();
    const parsed = parseMessage({ version: PROTOCOL_VERSION, id, kind: "request", type, payload });
    if (!parsed.ok) throw new Error(`Window generated an invalid ${type}`);
    deliver({
      message: parsed.message,
      ...(then ? { then } : {}),
      ...(serial === undefined ? {} : { serial }),
    });
  };

  /** Bumped by each new draft and each pack, so a reply only lands on the request it answers. */
  let draftSerial = 0;
  let packSerial = 0;
  /** Drafts whose Stop was pressed before the host started their thread, by serial. */
  const stopAsked = new Set<number>();
  return createStore<ThreadsState>()((set, get) => {
    /** The host's threads, with what this window knows sooner: threads it started and messages it sent. */
    const showThreads = () => {
      const { pending, listed, started } = get();
      const own = Object.values(started).filter(({ id }) => !listed?.some((t) => t.id === id));
      if (!listed && own.length === 0) {
        set({ threads: null });
        return;
      }
      set({
        threads: [...own, ...(listed ?? [])].map((thread) => {
          const sent = pending[thread.id];
          return sent && (thread.status === "Open" || thread.status === "Settled")
            ? {
                ...thread,
                status: "Working",
                settledAt: null,
                updatedAt: Math.max(thread.updatedAt, sent.at),
              }
            : thread;
        }),
      });
    };
    const setListed = (threads: readonly ThreadSummary[] | null) => {
      set(({ started }) => ({
        listed: threads,
        started: threads
          ? Object.fromEntries(
              Object.entries(started).filter(([id]) => !threads.some((t) => t.id === id)),
            )
          : started,
      }));
      showThreads();
    };
    const list = (onListed?: (threads: readonly ThreadSummary[]) => void) =>
      request("threads.list", {}, (reply) => {
        if (reply.type !== "threads.result") {
          setListed(null);
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
    const sendMessage = (
      threadId: string,
      payload: ReturnType<typeof message>,
      at: number = Date.now(),
    ) => {
      const echo: PendingSend = {
        prompt: payload.prompt,
        ...(payload.attachments
          ? { attachments: payload.attachments.map(({ name }) => name) }
          : {}),
        at,
        after: get().events[threadId]?.at(-1)?.sequence ?? 0,
      };
      set(({ failures, pending }) => ({
        failures: without(failures, threadId),
        pending: { ...pending, [threadId]: echo },
      }));
      showThreads();
      // The host answers when the turn ends, so the journal, not this reply, usually ends the echo.
      request("thread.send", { threadId, message: payload }, (reply) => {
        const reason = failed(reply);
        set(({ failures, pending }) => ({
          pending: pending[threadId] === echo ? without(pending, threadId) : pending,
          ...(reason ? { failures: { ...failures, [threadId]: reason } } : {}),
        }));
        showThreads();
        list();
      });
    };
    const pack = (subject: string) => {
      const serial = ++packSerial;
      request("thread.chip", { id: subject }, (reply) => {
        const { draft } = get();
        if (serial !== packSerial || draft?.subject?.id !== subject) return;
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
    };

    /** The host went away: its threads are not known, and what it was doing ends or starts again. */
    const lose = (gone: string | null, replayed: ReadonlySet<number> = new Set()) => {
      const { draft } = get();
      let next = draft;
      if (next?.sending !== undefined)
        next = failDraft(next, gone ?? "The host restarted before the thread started.");
      if (gone && next?.chip?.state === "packing" && next.subject)
        next = { ...next, chip: { state: "done", ok: false, id: next.subject.id, reason: gone } };
      for (const serial of stopAsked) if (!replayed.has(serial)) stopAsked.delete(serial);
      set({
        threads: null,
        listed: null,
        started: {},
        pending: {},
        stopping: {},
        ...(next === draft ? {} : { draft: next }),
      });
      if (next?.chip?.state === "packing" && next.subject) pack(next.subject.id);
    };

    return {
      threads: null,
      events: {},
      failures: {},
      pending: {},
      stopping: {},
      listed: null,
      started: {},
      catalog: null,
      choices: {},
      draft: null,
      target: null,
      undo: null,
      setTarget: (target) => set({ target }),
      startDraft(scope, target, from, text, landsIn) {
        draftSerial += 1;
        const draft: Draft = {
          scope,
          opened: draftSerial,
          ...(text ? { text } : {}),
          ...(target?.parent ? { parent: target.parent } : {}),
          ...(from ? { from } : {}),
          ...(landsIn ? { landsIn } : {}),
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
        if (!draft) return;
        if (landsInScope(scope)) set({ draft: { ...draft, scope } });
        else {
          const { landsIn: _, ...rest } = draft;
          set({ draft: { ...rest, scope } });
        }
      },
      setDraftLandsIn(choice) {
        const { draft } = get();
        if (!draft || draft.sending !== undefined) return;
        const { landsIn: _, ...rest } = draft;
        set({ draft: choice === "asking" ? rest : { ...rest, landsIn: choice } });
      },
      attachDraftChip(target) {
        const { draft } = get();
        if (!draft || draft.sending !== undefined) return;
        const { failure: _, origin: __, parent: ___, ...rest } = draft;
        set({
          draft: {
            ...rest,
            ...(target.parent ? { parent: target.parent } : {}),
            subject: { id: target.subject, label: target.label },
            ...(target.origin ? { origin: target.origin } : {}),
            chip: { state: "packing" },
          },
        });
        pack(target.subject);
      },
      removeDraftChip() {
        const { draft } = get();
        if (!draft) return;
        const { chip: _, subject: __, parent: ___, ...rest } = draft;
        set({ draft: rest });
      },
      sendDraft({ words, chipOnly: asked }, onStarted) {
        const { draft } = get();
        if (!draft || draft.sending !== undefined || draft.chip?.state === "packing") return;
        const choice = get().choices.draft;
        const chip = draft.chip?.state === "done" && draft.chip.ok ? draft.chip : undefined;
        const chipOnly = asked && chip !== undefined;
        const text = asked ? CHIP_ONLY_PROMPT : words.trim();
        const { failure: _, ...rest } = draft;
        if (draft.parent && chip?.id !== findingOf(draft.parent)) {
          const why = draft.chip?.state === "done" && !draft.chip.ok ? ` ${draft.chip.reason}` : "";
          set({
            draft: {
              ...rest,
              failure: {
                reason: `Not sent: the finding this continues did not pack.${why}`,
                words,
              },
            },
          });
          return;
        }
        const sending = {
          words,
          message: {
            prompt: text,
            ...(chip ? { attachments: [chip.attachment.name] } : {}),
            at: Date.now(),
            after: 0,
          },
        };
        set({ draft: { ...rest, sending } });
        const definition = {
          scope: draft.scope,
          title: threadTitle(chipOnly && draft.subject ? draft.subject.label : text),
          ...(draft.subject && chip ? { subject: draft.subject.id } : {}),
          ...(draft.parent ? { parent: draft.parent } : {}),
          ...(draft.landsIn && draft.landsIn !== "asking"
            ? { landsIn: { target: draft.landsIn } }
            : {}),
        };
        const serial = draftSerial;
        const onReply = (reply: Message) => {
          const current = serial === draftSerial ? get().draft : null;
          const stopNow = stopAsked.delete(serial);
          if (reply.type !== "thread.started") {
            const stale =
              reply.type === "error" && reply.payload.code === STALE_PREVIEW && current?.subject;
            if (current)
              set({
                draft: {
                  ...failDraft(current, failed(reply) ?? "The thread did not start."),
                  ...(stale ? { chip: { state: "packing" } as const } : {}),
                },
              });
            if (stale) pack(stale.id);
            return;
          }
          const { threadId, thread } = reply.payload;
          set(({ started }) => ({ started: { ...started, [threadId]: thread } }));
          if (choice) set(({ choices }) => ({ choices: { ...choices, [threadId]: choice } }));
          const payload = message(threadId, text, chip?.attachment);
          if (current) {
            onStarted(threadId);
            set({ draft: null, events: { ...get().events, [threadId]: [] } });
            subscribe(threadId);
          }
          sendMessage(threadId, payload, sending.message.at);
          if (stopNow) get().stop(threadId);
        };
        request("thread.start", definition, onReply, serial);
      },
      stopDraft() {
        const { draft } = get();
        if (!draft?.sending) return;
        stopAsked.add(draftSerial);
        set({ draft: { ...draft, sending: { ...draft.sending, stopping: true } } });
      },
      send: (threadId, text) => sendMessage(threadId, message(threadId, text)),
      decideApproval: (threadId, turnId, approvalId, approved) =>
        request("thread.approval", { threadId, turnId, approvalId, approved }, (reply) => {
          if (reply.type !== "thread.approval.result" || reply.payload.decided) return;
          list();
        }),
      stop(threadId) {
        set(({ stopping }) => ({ stopping: { ...stopping, [threadId]: true } }));
        request("thread.stop", { threadId }, () => {
          set(({ stopping }) => ({ stopping: without(stopping, threadId) }));
          list();
        });
      },
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
          const replayed = heldStarts();
          held = [];
          waiting.clear();
          lose(null, replayed);
          list();
          for (const threadId of Object.keys(get().events)) subscribe(threadId);
          for (const entry of queued)
            if (!REDONE_AT_HELLO.has(entry.message.type as Request["type"])) deliver(entry);
          return;
        }
        if (reply.type === "error" && reply.payload.code === "host_unavailable") {
          waiting.clear();
          lose(reply.payload.message, heldStarts());
          return;
        }
        const then = waiting.get(reply.id);
        if (then && reply.kind === "response") {
          waiting.delete(reply.id);
          then(reply);
        }
        if (reply.type === "threads.result") setListed(reply.payload.threads);
        else if (reply.type === "models.result") set({ catalog: reply.payload });
        else if (reply.type === "thread.events") {
          const { threadId, events } = reply.payload;
          const known = get().events[threadId] ?? [];
          const after = known.at(-1)?.sequence ?? 0;
          const fresh = events.filter(({ sequence }) => sequence > after);
          if (fresh.length === 0) return;
          const echo = get().pending[threadId];
          const begun = (type: ThreadWireEvent["type"]) =>
            fresh.some((event) => event.type === type && (!echo || event.sequence > echo.after));
          const answered = echo && (begun("turn.finished") || begun("message.cancelled"));
          set(({ events: all, pending, stopping }) => ({
            events: { ...all, [threadId]: [...known, ...fresh] },
            ...(answered ? { pending: without(pending, threadId) } : {}),
            ...(stopping[threadId] && begun("turn.finished")
              ? { stopping: without(stopping, threadId) }
              : {}),
          }));
          if (answered) showThreads();
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
