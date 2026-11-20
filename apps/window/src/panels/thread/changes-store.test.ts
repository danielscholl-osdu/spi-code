// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Message, PROTOCOL_VERSION } from "@spi-code/contracts";
import { expect, it } from "vitest";
import { createChangesStore } from "./changes-store.js";

const HEAD = "b".repeat(40);

function host() {
  const posted: Message[] = [];
  const store = createChangesStore((message) => posted.push(message));
  const reply = (type: string, payload: unknown, kind = "response", id = posted.at(-1)?.id) =>
    store.getState().receive({ version: PROTOCOL_VERSION, id, kind, type, payload });
  return { store, posted, reply };
}

it("re-reads the changes after a commit and keeps the host's outcome", () => {
  const { store, posted, reply } = host();
  store.getState().commit("t1", "Change it");
  expect(store.getState().commits.t1).toEqual({ outcome: "committing" });
  store.getState().commit("t1", "Twice");
  expect(posted.map(({ type, payload }) => [type, payload])).toEqual([
    ["thread.commit", { threadId: "t1", message: "Change it" }],
  ]);
  reply("thread.committed", { threadId: "t1", commit: { outcome: "committed", head: HEAD } });
  expect(store.getState().commits.t1).toEqual({ outcome: "committed", head: HEAD });
  expect(posted.at(-1)?.type).toBe("thread.changes");
  expect(store.getState().changes.t1).toEqual({ state: "reading" });
});

it.each([
  ["the host restarts", { type: "host.hello", kind: "event" }],
  ["the host goes away", { type: "error", kind: "response", code: "host_unavailable" }],
])("calls a commit in flight not known when %s, and reads again", (_, event) => {
  const { store, posted, reply } = host();
  store.getState().refresh("t1");
  reply("thread.changes.result", {
    threadId: "t1",
    changes: { state: "read", head: HEAD, ahead: 0, uncommitted: true, files: [] },
  });
  store.getState().commit("t1", "Change it");
  const commit = posted.at(-1)?.id;
  const payload =
    event.type === "host.hello"
      ? { pid: 2 }
      : { code: "host_unavailable", message: "The host stopped." };
  reply(event.type, payload, event.kind);
  expect(store.getState().commits.t1).toMatchObject({ outcome: "not known" });
  expect(posted.at(-1)?.type).toBe("thread.changes");
  reply(
    "thread.committed",
    { threadId: "t1", commit: { outcome: "committed", head: HEAD } },
    "response",
    commit,
  );
  expect(store.getState().commits.t1).toMatchObject({ outcome: "not known" });
});

it("says why the worktree was not read when the host answers with an error", () => {
  const { store, reply } = host();
  store.getState().refresh("t1");
  reply("error", { code: "thread_failed", message: "Git is unavailable." });
  expect(store.getState().changes.t1).toEqual({
    state: "not read",
    reason: "Git is unavailable.",
  });
});
