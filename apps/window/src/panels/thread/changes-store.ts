// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Message, PROTOCOL_VERSION, parseMessage } from "@spi-code/contracts";
import { createStore } from "zustand/vanilla";

type Payload<T extends Message["type"]> = Extract<Message, { type: T }>["payload"];
export type ThreadChanges = Payload<"thread.changes.result">["changes"];
export type FileDiff = Payload<"thread.diff.result">["diff"];
export type CommitResult = Payload<"thread.committed">["commit"];
type Request = Extract<Message, { kind: "request" }>;

const reading = { state: "reading" } as const;
const tooLong = "A commit message is 10,000 characters at most.";
const diffKey = (threadId: string, path: string) => `${threadId}\0${path}`;

type ChangesState = {
  /** Absent until asked; "reading" while the host reads the worktree. */
  changes: Readonly<Record<string, ThreadChanges | typeof reading>>;
  diffs: Readonly<Record<string, FileDiff | typeof reading>>;
  commits: Readonly<Record<string, CommitResult | { outcome: "committing" }>>;
  refresh(threadId: string): void;
  readDiff(threadId: string, path: string): void;
  commit(threadId: string, message: string): void;
  receive(input: unknown): void;
};

export function diffOf(state: ChangesState, threadId: string, path: string) {
  return state.diffs[diffKey(threadId, path)];
}

export function createChangesStore(post: (message: Message) => void = postToHost) {
  const waiting = new Map<string, (reply: Message) => void>();
  /** The newest read per thread or diff key; a reply to an older one is dropped. */
  const latest = new Map<string, string>();
  /** False when the contract refuses the payload, and nothing is sent. */
  const request = (
    type: Request["type"],
    payload: Request["payload"],
    then: (reply: Message) => void,
    newest?: string,
  ): boolean => {
    const id = crypto.randomUUID();
    const parsed = parseMessage({ version: PROTOCOL_VERSION, id, kind: "request", type, payload });
    if (!parsed.ok) return false;
    if (newest !== undefined) latest.set(newest, id);
    const settle = (reply: Message) => {
      if (newest !== undefined && latest.get(newest) !== id) return;
      if (newest !== undefined) latest.delete(newest);
      then(reply);
    };
    waiting.set(id, settle);
    try {
      post(parsed.message);
    } catch {
      waiting.delete(id);
      settle({
        version: PROTOCOL_VERSION,
        id,
        kind: "response",
        type: "error",
        payload: { code: "host_unavailable", message: "The host is not connected." },
      });
    }
    return true;
  };
  const failure = (reply: Message, fallback: string) =>
    reply.type === "error" ? reply.payload.message : fallback;

  const without = (diffs: ChangesState["diffs"], threadId: string) =>
    Object.fromEntries(Object.entries(diffs).filter(([key]) => !key.startsWith(`${threadId}\0`)));

  return createStore<ChangesState>()((set, get) => {
    const refresh = (threadId: string) => {
      set(({ changes, diffs }) => ({
        changes: { ...changes, [threadId]: reading },
        diffs: without(diffs, threadId),
      }));
      for (const key of latest.keys()) if (key.startsWith(`${threadId}\0`)) latest.delete(key);
      const sent = request(
        "thread.changes",
        { threadId },
        (reply) => {
          const changes: ThreadChanges =
            reply.type === "thread.changes.result"
              ? reply.payload.changes
              : {
                  state: "not read",
                  reason: failure(reply, "The host did not read the worktree."),
                };
          set((state) => ({ changes: { ...state.changes, [threadId]: changes } }));
        },
        threadId,
      );
      if (!sent) throw new Error("Window generated an invalid thread.changes");
    };
    /** The host went away: a commit in flight may or may not have run. A new host is read again. */
    const lose = (reason: string, restarted: boolean) => {
      waiting.clear();
      latest.clear();
      const commits = { ...get().commits };
      for (const [threadId, commit] of Object.entries(commits))
        if (commit.outcome === "committing") commits[threadId] = { outcome: "not known", reason };
      const unread = { state: "not read", reason } as const;
      const changes = Object.fromEntries(Object.keys(get().changes).map((id) => [id, unread]));
      set({ commits, diffs: {}, ...(restarted ? {} : { changes }) });
      if (restarted) for (const threadId of Object.keys(get().changes)) refresh(threadId);
    };
    return {
      changes: {},
      diffs: {},
      commits: {},
      refresh,
      readDiff(threadId, path) {
        const key = diffKey(threadId, path);
        set(({ diffs }) => ({ diffs: { ...diffs, [key]: reading } }));
        const sent = request(
          "thread.diff",
          { threadId, path },
          (reply) => {
            const diff: FileDiff =
              reply.type === "thread.diff.result"
                ? reply.payload.diff
                : { state: "not read", reason: failure(reply, "The host did not read the diff.") };
            set(({ diffs }) => ({ diffs: { ...diffs, [key]: diff } }));
          },
          key,
        );
        if (!sent) throw new Error("Window generated an invalid thread.diff");
      },
      commit(threadId, message) {
        if (get().commits[threadId]?.outcome === "committing") return;
        const done = (commit: CommitResult | { outcome: "committing" }) =>
          set(({ commits }) => ({ commits: { ...commits, [threadId]: commit } }));
        done({ outcome: "committing" });
        const sent = request("thread.commit", { threadId, message }, (reply) => {
          done(
            reply.type === "thread.committed"
              ? reply.payload.commit
              : { outcome: "not known", reason: failure(reply, "The host gave no result.") },
          );
          refresh(threadId);
        });
        if (!sent) done({ outcome: "refused", reason: tooLong });
      },
      receive(input) {
        const parsed = parseMessage(input);
        if (!parsed.ok) return;
        const reply = parsed.message;
        if (reply.type === "host.hello") return lose("The host restarted during the commit.", true);
        if (reply.type === "error" && reply.payload.code === "host_unavailable")
          return lose(reply.payload.message, false);
        if (reply.kind !== "response") return;
        const then = waiting.get(reply.id);
        if (!then) return;
        waiting.delete(reply.id);
        then(reply);
      },
    };
  });
}

function postToHost(message: Message) {
  window.spi?.postMessage(message);
}

export const changesStore = createChangesStore();
