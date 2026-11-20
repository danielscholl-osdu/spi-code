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

it("calls a commit in flight not known when the host restarts, and reads again", () => {
  const { store, posted, reply } = host();
  store.getState().refresh("t1");
  reply("thread.changes.result", {
    threadId: "t1",
    changes: { state: "read", head: HEAD, ahead: 0, uncommitted: true, files: [] },
  });
  store.getState().commit("t1", "Change it");
  const commit = posted.at(-1)?.id;
  reply("host.hello", { pid: 2 }, "event");
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

it("reads nothing more once the host has gone away, and says so", () => {
  const { store, posted, reply } = host();
  store.getState().refresh("t1");
  store.getState().commit("t1", "Change it");
  const asked = posted.length;
  const gone = { code: "host_unavailable", message: "The host stopped." };
  reply("error", gone);
  reply("error", gone);
  expect(posted).toHaveLength(asked);
  expect(store.getState().commits.t1).toEqual({
    outcome: "not known",
    reason: "The host stopped.",
  });
  expect(store.getState().changes.t1).toEqual({ state: "not read", reason: "The host stopped." });
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
