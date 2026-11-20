// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  FocusItemSchema,
  type Message,
  PROTOCOL_VERSION,
  type ThreadWireEvent,
  TodayLineSchema,
  ViewSnapshotSchema,
} from "@spi-code/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readFixture } from "../../../../scripts/watch-generated.mjs";
import { routeHash } from "../app/navigation.js";
import { Shell } from "../app/Shell.js";
import { todayContent } from "../components/opened-body/content.js";
import { OpenedBody } from "../components/opened-body/OpenedBody.js";
import recorded from "../components/opened-body/sweep-1116.json?raw";
import { pin } from "../store/pins.js";
import { watchStore } from "../store/watch.js";
import { fixtureLoader, installSpi } from "../test-utils/harness.js";
import nov16 from "../views/today/snapshot-1116.json?raw";
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
  bytes: 1234,
  attachment: {
    name: "context:sync-run:indexer",
    content: '{"id":"sync-run:indexer","trimmed":"Over 6000 UTF-8 bytes: left out why."}',
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
  /** No port yet: the preload throws, as it does before the host port arrives. */
  let offline = false;
  let refuseStart: { code: string; message: string } | undefined;
  const send = (type: string, id: string, payload: unknown, kind = "response") =>
    deliver({ version: PROTOCOL_VERSION, id, kind, type, payload });
  const summaries = () =>
    started.map(({ id, thread }) => ({
      id,
      thread,
      status: statuses.get(id) ?? "Working",
      sequence: 1,
      updatedAt: 1,
      settledAt: statuses.get(id) === "Settled" ? 1 : null,
      done: false,
    }));
  const answer = (request: Request) => {
    if (offline) throw new Error("Host port is not connected");
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
        if (refuseStart) return send("error", request.id, refuseStart);
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
      case "thread.settle":
        if (["Working", "Waiting on you"].includes(statuses.get(request.payload.threadId) ?? "")) {
          return send("error", request.id, {
            code: "thread_busy",
            message: "The thread is still running.",
          });
        }
        statuses.set(request.payload.threadId, "Settled");
        return send("thread.settled", request.id, request.payload);
      case "thread.unsettle":
        statuses.set(request.payload.threadId, "Open");
        return send("thread.unsettled", request.id, { threadId: request.payload.threadId });
      case "thread.seen":
        return send("thread.seen.result", request.id, { threadId: request.payload.threadId });
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
    hello: () => {
      offline = false;
      send("host.hello", "hello", { pid: 1 }, "event");
    },
    disconnect: () => {
      offline = true;
    },
    refuseStart: (refusal?: { code: string; message: string }) => {
      refuseStart = refusal;
    },
    unavailable: (message: string) =>
      send("error", "host-supervisor", { code: "host_unavailable", message }),
    connect: (listener: (message: unknown) => void) => {
      deliver = listener;
      return () => {};
    },
    answer,
    addThread: (id: string, thread: ThreadSummary["thread"], status: Status) => {
      if (!started.some((entry) => entry.id === id)) started.push({ id, thread });
      statuses.set(id, status);
    },
    replyToLatest: (type: Request["type"], payload: unknown) => {
      const request = [...posted].reverse().find((entry) => entry.type === type);
      if (!request) throw new Error(`No posted ${type}`);
      send(type === "thread.settle" ? "thread.settled" : "thread.unsettled", request.id, payload);
    },
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
    /^Context · indexer · from the sweep at .+ · 1 item, 1,234 bytes$/,
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
    "No sweep has been saved. Program threads come with a later build. Choose a service to ask in.",
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

it("settles with Undo, keeps settled threads in the footer, and nests below a pinned service", async () => {
  await askAndSend("Why is the sync halted?");
  host.statuses.set("t1", "Waiting on you");
  await act(async () => host.relist());
  const group = (name: string) =>
    all(`#app-sidebar [aria-label="${name}"] [data-thread-row]`).map(
      (row) => row.dataset.threadRow,
    );
  expect(group("Other threads")).toEqual(["t1"]);
  expect(all("#app-sidebar .sidebar-thread-settle")).toEqual([]);

  host.statuses.set("t1", "Open");
  await act(async () => host.relist());
  expect(group("Other threads")).toEqual(["t1"]);
  await click(buttonNamed("Settle"));
  expect(document.querySelector(".settle-toast")?.textContent).toMatch(/^Settled /);
  expect(group("Settled")).toEqual([]);
  await click(buttonNamed(/^Settled 1/));
  expect(group("Settled")).toEqual(["t1"]);

  await click(buttonNamed("Undo"));
  expect(host.sent("thread.unsettle").at(-1)?.payload).toEqual({
    threadId: "t1",
    restore: true,
  });
  expect(group("Settled")).toEqual([]);
  expect(group("Other threads")).toEqual(["t1"]);
  await act(async () => pin("indexer"));
  expect(group("Other threads")).toEqual([]);
  expect(all('#app-sidebar [data-nested] [data-thread-row="t1"]')).toHaveLength(1);
});

it("chooses from the refreshed list after settling and does not override newer navigation", async () => {
  host.addThread("t1", { scope: "indexer", title: "First" }, "Open");
  host.addThread("t2", { scope: "storage", title: "Second" }, "Open");
  host.addThread("t3", { scope: "legal", title: "Third" }, "Open");
  await act(async () => {
    host.relist();
    window.location.hash = "#thread/t1";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  host.silent.add("thread.settle");
  const titleSettle = container.querySelector<HTMLElement>(".thread-settle");
  if (!titleSettle) throw new Error("Missing title settle action");
  await click(titleSettle);
  host.statuses.set("t1", "Settled");
  host.statuses.set("t2", "Settled");
  await act(async () => host.replyToLatest("thread.settle", { threadId: "t1" }));
  expect(window.location.hash).toBe("#thread/t3");

  host.silent.add("thread.settle");
  const mac = /Mac|iPhone|iPad/u.test(navigator.userAgent);
  await act(async () =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "s",
        shiftKey: true,
        metaKey: mac,
        ctrlKey: !mac,
        bubbles: true,
      }),
    ),
  );
  await act(async () => {
    window.location.hash = "#today";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    host.replyToLatest("thread.settle", { threadId: "t3" });
  });
  expect(window.location.hash).toBe("#today");
});

it("reports the largest thread sequence already observed by the window", () => {
  const base = { threadId: "t1", at: 1 };
  threadStore.setState({
    threads: [
      {
        id: "t1",
        thread: { scope: "indexer" },
        status: "Open",
        sequence: 3,
        updatedAt: 1,
        settledAt: null,
        done: false,
      },
    ],
    events: {
      t1: [
        { ...base, sequence: 5, type: "thread.seen", seenSequence: 3 },
        { ...base, sequence: 6, type: "thread.settled", reason: "operator", settledAt: 1 },
      ],
    },
  });
  threadStore.getState().open("t1");
  expect(host.sent("thread.seen").at(-1)?.payload).toEqual({ threadId: "t1", sequence: 6 });
});

it("keeps an unreadable thread muted in place and does not open it", async () => {
  const thread: ThreadSummary = {
    id: "damaged",
    thread: { scope: "not known" },
    status: "Can't be read",
    sequence: 4,
    updatedAt: 1,
    settledAt: null,
    done: true,
  };
  await act(async () => threadStore.setState({ threads: [thread] }));
  const row = all('[data-thread-row="damaged"]');
  expect(row).toHaveLength(0);
  const muted = container.querySelector<HTMLElement>(
    `#app-sidebar .thread-item[data-state="Can't be read"]`,
  );
  expect(
    (muted?.querySelector(".sidebar-thread-end") as HTMLElement | null)?.dataset.end,
  ).toBeUndefined();
  expect(muted?.textContent).toContain("Can't be read");
  expect(muted?.getAttribute("title")).toBe("damaged");
  expect(muted?.querySelector("button")?.hasAttribute("disabled")).toBe(true);
  await click(muted?.querySelector<HTMLElement>("button") as HTMLElement);
  expect(window.location.hash).toBe("#today");
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

const status = () => container.querySelector(".thread-title-status")?.textContent;
const notice = () => container.querySelector(".thread-notice")?.textContent ?? null;
const chipLabels = () =>
  all(".thread-chip > button[aria-expanded]").map((chip) => chip.textContent);

it("opens a thread route before the host port arrives, and asks for it once the host says hello", async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  threadStore.setState(initialThreads, true);
  host.disconnect();
  window.location.hash = "#thread/t1";
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<Shell />));
  expect(host.posted).toEqual([]);

  await act(async () => host.hello());
  expect(host.sent("thread.subscribe").map(({ payload }) => payload)).toEqual([
    { threadId: "t1", fromSequence: 0 },
  ]);
  expect(host.sent("threads.list")).toHaveLength(1);
  expect(host.sent("models.list")).toHaveLength(1);
});

it("says not known when a replacement host cannot list its threads, or the host is unavailable", async () => {
  await askAndSend("Why is the sync halted?");
  const base = { threadId: "t1", at: 1 };
  await act(async () =>
    host.events("t1", [
      { ...base, sequence: 1, type: "thread.created", thread: { scope: "indexer" } },
      { ...base, sequence: 2, type: "message.sent", messageId: "m1", message: { prompt: "Why?" } },
      { ...base, sequence: 3, type: "turn.started", turnId: "u1", messageId: "m1" },
    ]),
  );
  expect(status()).toBe("Working");
  expect(buttonNamed("Stop")).toBeDefined();

  host.failing.add("threads.list");
  host.failing.add("thread.subscribe");
  await act(async () => host.hello());
  expect(status()).toBe("not known");
  expect(all('#app-sidebar [data-thread-row="t1"]')).toEqual([]);
  expect(all("button").some((button) => button.textContent === "Stop")).toBe(false);

  host.failing.clear();
  await act(async () => host.hello());
  expect(status()).toBe("Working");
  await act(async () => host.unavailable("Host stopped after repeated crashes."));
  expect(status()).toBe("not known");
  expect(all('#app-sidebar [data-thread-row="t1"]')).toEqual([]);
});

it("finishes a pack the host was interrupted in: a restart packs again, an unavailable host says why", async () => {
  host.silent.add("thread.chip");
  await openRow(halted);
  await click(askAbout() as HTMLElement);
  await type("Why is the sync halted?");
  expect(notice()).toBe("Packing what you were looking at…");

  host.silent.delete("thread.chip");
  host.chips.set(PACKED.id, PACKED);
  await act(async () => host.hello());
  expect(host.sent("thread.chip")).toHaveLength(2);
  expect(chipLabels()).toEqual([`${halted.title} · trimmed`]);
  expect(notice()).toBeNull();
  expect(container.querySelector("textarea")?.value).toBe("Why is the sync halted?");
  expect(buttonNamed("Send ⏎").hasAttribute("disabled")).toBe(false);

  host.silent.add("thread.chip");
  await click(askAbout() as HTMLElement);
  expect(notice()).toBe("Packing what you were looking at…");
  await act(async () => host.unavailable("Host stopped after repeated crashes."));
  expect(notice()).toBe("Host stopped after repeated crashes.");
  expect(chipLabels()).toEqual([]);
});

it("offers Ask about this on a service Overview fork row, scoped to that fork", async () => {
  const body = ViewSnapshotSchema.parse(JSON.parse(nov16));
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  const row = "sync-run:search";
  window.location.hash = routeHash({ kind: "service", id: "search", tab: "overview", row });
  await act(async () => window.dispatchEvent(new HashChangeEvent("hashchange")));
  const ask = container.querySelector<HTMLElement>(`li[data-row="${row}"] .ask-about`);
  expect(ask?.textContent).toBe("✦Ask about this");

  await click(ask as HTMLElement);
  expect(host.sent("thread.chip").map(({ payload }) => payload)).toEqual([{ id: row }]);
  expect(buttonNamed("Scope: search")).toBeDefined();
});

it("refuses a send whose preview went stale, keeps the words and shows the fresh preview", async () => {
  const fresh: ChipResult = {
    ...PACKED,
    attachment: { ...PACKED.attachment, content: '{"id":"sync-run:indexer","cause":"[redacted]"}' },
  };
  host.chips.set(PACKED.id, PACKED);
  await openRow(halted);
  await click(askAbout() as HTMLElement);
  await type("Why is the sync halted?");
  host.chips.set(PACKED.id, fresh);
  const reason = "What Copilot would receive changed since its preview.";
  host.refuseStart({ code: "stale_preview", message: reason });
  await click(buttonNamed("Send ⏎"));

  expect(window.location.hash).toBe("#thread/new");
  expect(notice()).toBe(reason);
  expect(host.sent("thread.send")).toEqual([]);
  expect(container.querySelector("textarea")?.value).toBe("Why is the sync halted?");
  await click(all(".thread-chip > button[aria-expanded]")[0] as HTMLElement);
  expect(container.querySelector(".thread-chip-preview")?.textContent).toBe(
    fresh.attachment.content,
  );

  host.refuseStart();
  await click(buttonNamed("Send ⏎"));
  expect(host.sent("thread.send").map(({ payload }) => payload)).toEqual([
    {
      threadId: "t1",
      message: { prompt: "Why is the sync halted?", attachments: [fresh.attachment] },
    },
  ]);
});
