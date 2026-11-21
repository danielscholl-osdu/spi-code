// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Message, PROTOCOL_VERSION, parseMessage } from "@spi-code/contracts";
import { createStore } from "zustand/vanilla";

type Publication = Extract<
  Message,
  { type: "thread.publication.result" }
>["payload"]["publication"];
type Outcome = Extract<Message, { type: "thread.published" }>["payload"]["publication"];
type Request = Extract<Message, { kind: "request" }>;

const reading = { state: "reading" } as const;

export type PublicationState = Publication | typeof reading;

type State = {
  publications: Readonly<Record<string, PublicationState>>;
  outcomes: Readonly<Record<string, Outcome | { outcome: "publishing" }>>;
  read(threadId: string): void;
  publish(threadId: string, head: string, observedHead: string | null): void;
  receive(input: unknown): void;
};

export function createPublicationStore(post: (message: Message) => void = postToHost) {
  const waiting = new Map<string, (reply: Message) => void>();
  const request = (
    type: Request["type"],
    payload: Request["payload"],
    reply: (message: Message) => void,
  ) => {
    const id = crypto.randomUUID();
    const parsed = parseMessage({ version: PROTOCOL_VERSION, id, kind: "request", type, payload });
    if (!parsed.ok) return false;
    waiting.set(id, reply);
    try {
      post(parsed.message);
    } catch {
      waiting.delete(id);
      reply({
        version: PROTOCOL_VERSION,
        id,
        kind: "response",
        type: "error",
        payload: { code: "host_unavailable", message: "The host is not connected." },
      });
    }
    return true;
  };

  return createStore<State>()((set, get) => ({
    publications: {},
    outcomes: {},
    read(threadId) {
      if (!get().publications[threadId])
        set(({ publications }) => ({ publications: { ...publications, [threadId]: reading } }));
      const sent = request("thread.publication", { threadId }, (reply) => {
        const publication: Publication =
          reply.type === "thread.publication.result"
            ? reply.payload.publication
            : {
                state: "not read",
                reason:
                  reply.type === "error"
                    ? reply.payload.message
                    : "The host did not read the publish destination.",
              };
        set((state) => ({
          publications: { ...state.publications, [threadId]: publication },
        }));
      });
      if (!sent) throw new Error("Window generated an invalid thread.publication");
    },
    publish(threadId, head, observedHead) {
      if (get().outcomes[threadId]?.outcome === "publishing") return;
      set(({ outcomes }) => ({
        outcomes: { ...outcomes, [threadId]: { outcome: "publishing" } },
      }));
      const sent = request("thread.publish", { threadId, head, observedHead }, (reply) => {
        const outcome: Outcome =
          reply.type === "thread.published"
            ? reply.payload.publication
            : {
                outcome: "not known",
                reason:
                  reply.type === "error"
                    ? reply.payload.message
                    : "The host gave no publishing result.",
              };
        set((state) => {
          const current = state.publications[threadId];
          return {
            outcomes: { ...state.outcomes, [threadId]: outcome },
            ...(outcome.outcome === "published" && current?.state === "ready"
              ? {
                  publications: {
                    ...state.publications,
                    [threadId]: { ...current, opens: "none", request: outcome.request },
                  },
                }
              : {}),
          };
        });
        if (outcome.outcome === "not known") {
          set(({ publications }) => ({
            publications: { ...publications, [threadId]: reading },
          }));
          get().read(threadId);
        } else if (outcome.outcome === "published" || outcome.outcome === "pushed") {
          get().read(threadId);
        }
      });
      if (!sent) {
        set(({ outcomes }) => ({
          outcomes: {
            ...outcomes,
            [threadId]: { outcome: "refused", reason: "The displayed head is not valid." },
          },
        }));
      }
    },
    receive(input) {
      const parsed = parseMessage(input);
      if (!parsed.ok) return;
      const message = parsed.message;
      if (message.type === "host.hello") {
        waiting.clear();
        const outcomes = Object.fromEntries(
          Object.entries(get().outcomes).map(([id, outcome]) => [
            id,
            outcome.outcome === "publishing"
              ? { outcome: "not known" as const, reason: "The host restarted while publishing." }
              : outcome,
          ]),
        );
        set({ outcomes });
        return;
      }
      if (message.kind !== "response") return;
      const reply = waiting.get(message.id);
      if (!reply) return;
      waiting.delete(message.id);
      reply(message);
    },
  }));
}

function postToHost(message: Message) {
  window.spi?.postMessage(message);
}

export const publicationStore = createPublicationStore();
