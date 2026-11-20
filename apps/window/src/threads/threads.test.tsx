// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  FocusItemSchema,
  type Message,
  PROTOCOL_VERSION,
  type ThreadWireEvent,
  TodayLineSchema,
} from "@spi-code/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readFixture } from "../../../../scripts/watch-generated.mjs";
import { Shell } from "../app/Shell.js";
import { todayContent } from "../components/opened-body/content.js";
import { OpenedBody } from "../components/opened-body/OpenedBody.js";
import recorded from "../components/opened-body/sweep-1116.json?raw";
import { watchStore } from "../store/watch.js";
import { fixtureLoader, installSpi } from "../test-utils/harness.js";
import { type ChipResult, type ThreadSummary, threadStore } from "./store.js";

type Request = Extract<Message, { kind: "request" }>;
type Status = ThreadSummary["status"];

const sweep = JSON.parse(recorded);
const lines = TodayLineSchema.array().parse(sweep.lines);
const items = FocusItemSchema.array().parse(sweep.items);
const place = { label: "Today › Blocked", destination: { kind: "today" } } as const;
const line = (id: string) => {
  const found = lines.find((entry) => entry.id === id);
  if (!found) throw new Error(`Missing fixture line ${id}`);
  return found;
};
/** One member, fork indexer: the row Ask about this scopes to indexer. */
const halted = todayContent({ line: line("blocked:sync-run:indexer"), items, place });
/** Five forks: no one fork to scope a thread to. */
const blocker = todayContent({ line: line("waiting:blocker:stack:lanes:gate2"), items, place });
const PACKED: ChipResult = {
  ok: true,
  id: "sync-run:indexer",
  sweptAt: "2026-11-16T13:50:00Z",
  trimmed: true,
  tokens: 1234,
  attachment: {
    name: "context:sync-run:indexer",
    content: '{"id":"sync-run:indexer","trimmed":"Over 2000 tokens: left out why."}',
  },
};

/** A host that answers the thread routes from what the window sent it, and nothing else. */
function fakeHost() {
  let deliver: (message: unknown) => void = () => {};
  const posted: Request[] = [];
  const started: { id: string; thread: ThreadSummary["thread"] }[] = [];
  const statuses = new Map<string, Status>();
  const chips = new Map<string, ChipResult>();
  const subscriptions = new Map<string, string>();
  const failing = new Set<Request["type"]>();
  const silent = new Set<Request["type"]>();
  const send = (type: string, id: string, payload: unknown, kind = "response") =>
    deliver({ version: PROTOCOL_VERSION, id, kind, type, payload });
  const summaries = () =>
    started.map(({ id, thread }) => ({
      id,
      thread,
      status: statuses.get(id) ?? "Working",
      sequence: 1,
      updatedAt: 1,
    }));
  const answer = (request: Request) => {
    posted.push(request);
    if (silent.has(request.type)) return;
    if (failing.has(request.type))
      return send("error", request.id, { code: "host_failed", message: "Host request failed" });
    switch (request.type) {
      case "threads.list":
        return send("threads.result", request.id, { threads: summaries() });
      case "thread.chip":
        return send(
          "thread.chip.result",
          request.id,
          chips.get(request.payload.id) ?? {
            ok: false,
            id: request.payload.id,
            reason: "No sweep has been saved.",
          },
        );
      case "thread.start": {
        const id = `t${started.length + 1}`;
        started.push({ id, thread: request.payload });
        return send("thread.started", request.id, { threadId: id });
      }
      case "thread.subscribe":
        subscriptions.set(request.payload.threadId, request.id);
        return;
      case "thread.send":
        return send("thread.sent", request.id, {
          threadId: request.payload.threadId,
          outcome: "completed",
        });
      case "models.list":
        return send("models.result", request.id, {
          models: [
            { id: "sonnet", name: "Sonnet", policy: { state: "enabled", reason: "not known" } },
            {
              id: "opus",
              name: "Opus",
              reasoning: { supported: true, levels: ["high"], defaultLevel: "high" },
              policy: { state: "enabled", reason: "not known" },
            },
          ],
          account: { login: "operator" },
        });
      default:
        return;
    }
  };
  return {
    posted,
    chips,
    statuses,
    failing,
    silent,
    hello: () => send("host.hello", "hello", { pid: 1 }, "event"),
    connect: (listener: (message: unknown) => void) => {
      deliver = listener;
      return () => {};
    },
    answer,
    sent: (type: Request["type"]) => posted.filter((request) => request.type === type),
    relist: () => send("threads.result", "push", { threads: summaries() }),
    events: (threadId: string, events: ThreadWireEvent[]) =>
      send("thread.events", subscriptions.get(threadId) ?? "", { threadId, events }, "event"),
  };
}

const loadFixture = fixtureLoader(readFixture);
const initialThreads = threadStore.getState();
let host: ReturnType<typeof fakeHost>;
let harness: ReturnType<typeof installSpi>;
let roots: Root[] = [];
let container: HTMLDivElement;

beforeEach(async () => {
  host = fakeHost();
  harness = installSpi({
    onMessage: host.connect,
    postMessage: (message) => host.answer(message as Request),
  });
  threadStore.setState(initialThreads, true);
  const body = loadFixture("snapshot-1106.json");
  watchStore.setState({ snapshot: { cursor: body.cursor, body }, setup: null });
  window.location.hash = "#today";
  container = document.createElement("div");
  document.body.append(container);
  roots = [createRoot(container)];
  await act(async () => roots[0]?.render(<Shell />));
});

afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  container.remove();
  harness.restore();
});

async function openRow(content: typeof halted) {
  const row = document.createElement("div");
  container.append(row);
  const root = createRoot(row);
  roots.push(root);
  await act(async () =>
    root.render(
      <OpenedBody
        content={content}
        selection={{ kind: "item", id: content.subject?.id ?? "" }}
        origin="today"
        onClose={() => {}}
      />,
    ),
  );
  return row;
}

const all = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)];
const buttonNamed = (name: string | RegExp) => {
  const found = all("button").find((button) => {
    const label = button.getAttribute("aria-label") ?? button.textContent ?? "";
    return typeof name === "string" ? label === name : name.test(label);
  });
  if (!found) throw new Error(`No button ${name}`);
  return found;
};
const click = (element: HTMLElement) => act(async () => element.click());
const askAbout = () => container.querySelector<HTMLElement>(".ask-about");

async function type(text: string) {
  const area = container.querySelector("textarea");
  if (!area) throw new Error("No composer");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(area, text);
    area.setSelectionRange(text.length, text.length);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function askAndSend(text: string) {
  host.chips.set(PACKED.id, PACKED);
  await openRow(halted);
  await click(askAbout() as HTMLElement);
  await type(text);
  await click(buttonNamed("Send ⏎"));
}

it("drafts one chip the host packed, scoped to the row's fork, and sends nothing", async () => {
  host.chips.set(PACKED.id, PACKED);
  await openRow(halted);
  await click(askAbout() as HTMLElement);

  expect(window.location.hash).toBe("#thread/new");
  expect(host.sent("thread.chip").map(({ payload }) => payload)).toEqual([{ id: PACKED.id }]);
  expect(host.sent("thread.start")).toEqual([]);
  expect(host.sent("thread.send")).toEqual([]);
  expect(buttonNamed("Scope: indexer")).toBeDefined();
  const chips = all(".thread-chip > button[aria-expanded]");
  expect(chips.map((chip) => chip.textContent)).toEqual([`${halted.title} · trimmed`]);
  await click(chips[0] as HTMLElement);
  expect(container.querySelector(".thread-chip-preview")?.textContent).toBe(
    PACKED.attachment.content,
  );
  expect(container.querySelector(".thread-context-line")?.textContent).toMatch(
    /^Context · indexer · from the sweep at .+ · 1 item, 1,234 tokens$/,
  );
});

it("shows the host's refusal in the draft and drafts no chip", async () => {
  await openRow(halted);
  await click(askAbout() as HTMLElement);
  expect(container.querySelector(".thread-notice")?.textContent).toBe("No sweep has been saved.");
  expect(all(".thread-chip > button[aria-expanded]")).toEqual([]);
});

it("offers no Ask about this on a row with no fork, and ⌘N there drafts Program, which cannot send yet", async () => {
  const row = await openRow(blocker);
  expect(row.querySelector(".ask-about")).toBeNull();
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "n", ctrlKey: true, bubbles: true }));
  });
  expect(window.location.hash).toBe("#thread/new");
  expect(container.querySelector(".thread-notice")?.textContent).toBe(
    "Program threads come with a later build. Choose a service to ask in.",
  );
  await type("Which forks are on 8.4?");
  expect(buttonNamed("Send ⏎").hasAttribute("disabled")).toBe(true);
  expect(host.sent("thread.start")).toEqual([]);
});

it("starts a thread from the row through the routes, and the row then opens that thread", async () => {
  await askAndSend("Why is the sync halted?");

  expect(host.sent("thread.start").map(({ payload }) => payload)).toEqual([
    { scope: "indexer", title: "Why is the sync halted?", subject: PACKED.id },
  ]);
  expect(host.sent("thread.send").map(({ payload }) => payload)).toEqual([
    {
      threadId: "t1",
      message: { prompt: "Why is the sync halted?", attachments: [PACKED.attachment] },
    },
  ]);
  expect(window.location.hash).toBe("#thread/t1");
  expect(threadStore.getState().draft).toBeNull();

  window.location.hash = "#today";
  await act(async () => window.dispatchEvent(new HashChangeEvent("hashchange")));
  const owned = askAbout();
  expect(owned?.textContent).toBe("✦Why is the sync halted? · Working");
  await click(owned as HTMLElement);
  expect(window.location.hash).toBe("#thread/t1");
});

it("groups the sidebar by status and moves a settled thread to the shelf", async () => {
  await askAndSend("Why is the sync halted?");
  host.statuses.set("t1", "Waiting on you");
  await act(async () => host.relist());
  const group = (name: string) =>
    all(`#app-sidebar [aria-label="${name}"] [data-thread-row]`).map(
      (row) => row.dataset.threadRow,
    );
  expect(group("Waiting on you")).toEqual(["t1"]);
  expect(group("Working")).toEqual([]);

  host.statuses.set("t1", "Settled");
  await act(async () => host.relist());
  expect(group("Waiting on you")).toEqual([]);
  expect(group("Settled")).toEqual([]);
  const shelf = buttonNamed(/^Settled 1/);
  await click(shelf);
  expect(group("Settled")).toEqual(["t1"]);
});

it("sends a model chosen in a thread to the host route and leaves one line in the timeline", async () => {
  await askAndSend("Why is the sync halted?");
  await click(buttonNamed(/^Model: /));
  await click(buttonNamed(/^Opus/));
  await type("Look again.");
  await click(buttonNamed("Send ⏎"));
  expect(host.sent("thread.send").at(-1)?.payload).toEqual({
    threadId: "t1",
    message: { prompt: "Look again.", model: "opus", reasoningEffort: "high" },
  });

  const base = { threadId: "t1", at: 1 };
  await act(async () =>
    host.events("t1", [
      { ...base, sequence: 1, type: "thread.created", thread: { scope: "indexer" } },
      { ...base, sequence: 2, type: "message.sent", messageId: "m1", message: { prompt: "Why?" } },
      {
        ...base,
        sequence: 3,
        type: "message.sent",
        messageId: "m2",
        message: { prompt: "Look again.", model: "opus", reasoningEffort: "high" },
      },
    ]),
  );
  expect(all(".thread-turn-end").map((row) => row.textContent)).toEqual([
    "Switched to Opus · High",
  ]);
});

it("says not known for a thread the host does not list", async () => {
  await act(async () => host.relist());
  window.location.hash = "#thread/gone";
  await act(async () => window.dispatchEvent(new HashChangeEvent("hashchange")));
  expect(container.querySelector(".thread-title-status")?.textContent).toBe("not known");
  expect(container.querySelector(".thread-notice")?.textContent).toBe(
    "The host does not know this thread.",
  );
});

it("keeps the operator's words in the draft when the thread does not start, or the host restarts first", async () => {
  host.failing.add("thread.start");
  await askAndSend("Why is the sync halted?");
  expect(window.location.hash).toBe("#thread/new");
  expect(container.querySelector(".thread-notice")?.textContent).toBe("Host request failed");
  expect(container.querySelector("textarea")?.value).toBe("Why is the sync halted?");
  expect(host.sent("thread.send")).toEqual([]);

  host.failing.delete("thread.start");
  host.silent.add("thread.start");
  await click(buttonNamed("Send ⏎"));
  expect(buttonNamed("Send ⏎").hasAttribute("disabled")).toBe(true);
  await act(async () => host.hello());
  expect(container.querySelector(".thread-notice")?.textContent).toBe(
    "The host restarted before the thread started.",
  );
  expect(container.querySelector("textarea")?.value).toBe("Why is the sync halted?");
  expect(buttonNamed("Send ⏎").hasAttribute("disabled")).toBe(false);
});

it("lists again and resubscribes an open thread from its last event when the host says hello", async () => {
  await askAndSend("Why is the sync halted?");
  const base = { threadId: "t1", at: 1 };
  await act(async () =>
    host.events("t1", [
      { ...base, sequence: 1, type: "thread.created", thread: { scope: "indexer" } },
      { ...base, sequence: 2, type: "message.sent", messageId: "m1", message: { prompt: "Why?" } },
    ]),
  );
  const lists = host.sent("threads.list").length;
  await act(async () => host.hello());
  expect(host.sent("threads.list")).toHaveLength(lists + 1);
  expect(host.sent("thread.subscribe").map(({ payload }) => payload)).toEqual([
    { threadId: "t1", fromSequence: 0 },
    { threadId: "t1", fromSequence: 2 },
  ]);
});
