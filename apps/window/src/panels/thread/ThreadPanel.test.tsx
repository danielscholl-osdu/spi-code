// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type Message,
  PROTOCOL_VERSION,
  type ThreadWireEvent,
  type ViewSnapshot,
} from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import { PANES_STORAGE_KEY, savePanes } from "../../app/pane-layout.js";
import { Shell } from "../../app/Shell.js";
import { watchStore } from "../../store/watch.js";
import { fixtureLoader, installSpi } from "../../test-utils/harness.js";
import { type ThreadSummary, threadStore } from "../../threads/store.js";
import { clockTime } from "../../time.js";
import { changesStore } from "./changes-store.js";
import { publicationStore } from "./publication-store.js";

type HappyWindow = { happyDOM: { setViewport(viewport: { width: number; height: number }): void } };

const fixture = fixtureLoader(readFixture)("snapshot-1106.json");
const cleanups: Array<() => Promise<void>> = [];
const watched = watchStore.getState();
const threads = threadStore.getState();
const changed = changesStore.getState();
const published = publicationStore.getState();

function summary(thread: ThreadSummary["thread"]): ThreadSummary {
  return {
    id: "t1",
    thread,
    status: "Open",
    sequence: 1,
    updatedAt: 1,
    settledAt: null,
    done: false,
  };
}

async function resizeWindow(width: number) {
  await act(async () => {
    (window as unknown as HappyWindow).happyDOM.setViewport({ width, height: 900 });
    window.dispatchEvent(new Event("resize"));
  });
}

async function mountShell(
  hash: string,
  listed: readonly ThreadSummary[] | null,
  snapshot: ViewSnapshot | null = fixture,
  events?: readonly ThreadWireEvent[],
) {
  window.location.hash = hash;
  watchStore.setState({
    snapshot: snapshot && { cursor: snapshot.cursor, body: snapshot },
    setup: null,
  });
  threadStore.setState({ threads: listed, ...(events ? { events: { t1: events } } : {}) });
  const harness = installSpi();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Shell />));
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
    harness.restore();
  });
  const layout = container.querySelector<HTMLElement>(".shell");
  if (!layout) throw new Error("Missing shell");
  const $ = <T extends Element = HTMLElement>(selector: string) =>
    container.querySelector<T & HTMLElement>(selector);
  return {
    $,
    layout,
    posted: () => harness.spi.postMessage.mock.calls.map(([message]) => message as Message),
    panel: () => $("#app-right-panel"),
    column: () => layout.style.getPropertyValue("--panel-col"),
    toggles: () => [
      ...container.querySelectorAll<HTMLButtonElement>("button[aria-label='Toggle right panel']"),
    ],
    title: () => $(".centre-title h1")?.textContent,
    tab: async (label: string) => {
      const tab = [...container.querySelectorAll<HTMLButtonElement>("[role=tab]")].find(
        (candidate) =>
          candidate.textContent === label || candidate.textContent?.startsWith(`${label} `),
      );
      if (!tab) throw new Error(`Missing tab ${label}`);
      await act(async () => tab.click());
      return $("#app-right-panel [role=tabpanel]");
    },
  };
}

const press = (key: string, target: EventTarget = window) =>
  act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ctrlKey: true }),
    );
  });

async function pointer(target: HTMLElement, type: string, clientX: number) {
  await act(async () => {
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX }),
    );
  });
}

async function drag(target: HTMLElement | null, from: number, to: number) {
  if (!target) throw new Error("Missing separator");
  await pointer(target, "pointerdown", from);
  await pointer(target, "pointermove", to);
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  await pointer(target, "pointerup", to);
}

const saved = () => JSON.parse(localStorage.getItem(PANES_STORAGE_KEY) ?? "null");
const PARTITION = summary({ scope: "partition", title: "Fix the blob retry test" });

beforeEach(async () => {
  localStorage.removeItem(PANES_STORAGE_KEY);
  await resizeWindow(1440);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  watchStore.setState(watched, true);
  threadStore.setState(threads, true);
  changesStore.setState(changed, true);
  publicationStore.setState(published, true);
  window.location.hash = "";
});

describe("a thread's right panel", () => {
  it.each(["#today", "#service/partition", "#thread/new"])(
    "is absent with no toggle and no shortcut on %s",
    async (hash) => {
      savePanes({ open: { rightPanel: true } });
      const shell = await mountShell(hash, [PARTITION]);
      await press("i");
      expect(shell.panel()).toBeNull();
      expect(shell.toggles()).toEqual([]);
      expect(shell.column()).toBe("0px");
      expect(saved().open.rightPanel).toBe(true);
    },
  );

  it("opens inline from its toggle, moves the toggle to its tabs and closes back", async () => {
    const shell = await mountShell("#thread/t1", [PARTITION]);
    expect(shell.panel()).toBeNull();
    const [open] = shell.toggles();
    expect(open?.closest(".centre-end")).not.toBeNull();
    open?.focus();
    await act(async () => open?.click());
    expect(shell.panel()?.hasAttribute("data-sheet")).toBe(false);
    expect(shell.layout.dataset.rightPresentation).toBe("inline");
    expect(shell.column()).toBe("360px");
    const [close] = shell.toggles();
    expect(shell.toggles()).toHaveLength(1);
    expect(close?.closest(".panel-tabs")).not.toBeNull();
    expect(saved().open.rightPanel).toBe(true);

    shell.$<HTMLButtonElement>("#app-right-panel [role=tab]")?.focus();
    await press("Escape", document.activeElement ?? window);
    expect(shell.panel()).toBeNull();
    expect(document.activeElement).toBe(shell.toggles()[0]);
    expect(saved().open.rightPanel).toBe(false);
    await press("i");
    expect(shell.panel()).not.toBeNull();
    await press("i");
    expect(shell.panel()).toBeNull();
  });

  it("resizes within the width budget, the centre keeping 520 px", async () => {
    const shell = await mountShell("#thread/t1", [PARTITION]);
    await act(async () => shell.toggles()[0]?.click());
    const edge = shell.$('[role="separator"][aria-label="Resize right panel"]');
    expect(edge?.getAttribute("aria-controls")).toBe("app-right-panel");
    expect(edge?.getAttribute("aria-valuemax")).toBe("688");
    await drag(edge, 1080, 1000);
    expect(saved().widths.rightPanel).toBe(440);
    expect(shell.column()).toBe("440px");
    await drag(shell.$('[role="separator"][aria-label="Resize right panel"]'), 1000, 400);
    expect(saved().widths.rightPanel).toBe(688);
    expect(1440 - 232 - 688).toBe(520);
    await resizeWindow(1100);
    expect(shell.column()).toBe("348px");
    expect(saved().widths.rightPanel).toBe(688);
  });

  it("becomes a sheet over the window under the narrow width", async () => {
    await resizeWindow(900);
    const shell = await mountShell("#thread/t1", [PARTITION]);
    await act(async () => shell.toggles()[0]?.click());
    expect(shell.layout.dataset.rightPresentation).toBe("sheet");
    expect(shell.panel()?.hasAttribute("data-sheet")).toBe(true);
    expect(shell.column()).toBe("0px");
    expect(shell.layout.style.getPropertyValue("--right-panel-width")).toBe("360px");
    expect(shell.$('[role="separator"][aria-label="Resize right panel"]')).toBeNull();
    expect(document.activeElement?.closest("#app-right-panel")).not.toBeNull();
    await act(async () => shell.$(".context-backdrop")?.click());
    expect(shell.panel()).toBeNull();
    await resizeWindow(1440);
    await act(async () => shell.toggles()[0]?.click());
    expect(shell.layout.dataset.rightPresentation).toBe("inline");
    await resizeWindow(900);
    expect(shell.panel()?.hasAttribute("data-sheet")).toBe(true);
  });

  it.each([
    ["folds from inline at 1440 into a sheet at 900", 1440, "fold"],
    ["is dismissed by Escape from the reply box after a fold", 1440, "escape"],
    ["is dismissed by Escape from a centre control when opened at 900", 900, "escape"],
  ] as const)("as a sheet, %s", async (_, width, step) => {
    await resizeWindow(width);
    const shell = await mountShell("#thread/t1", [PARTITION]);
    await act(async () => shell.toggles()[0]?.click());
    const evidence = [...shell.layout.querySelectorAll<HTMLElement>("[role=tab]")].find(
      (tab) => tab.textContent === "Evidence",
    );
    await act(async () => evidence?.click());
    const reply = shell.$<HTMLTextAreaElement>("textarea[aria-label='Message Copilot']");
    if (!reply) throw new Error("Missing reply box");
    reply.focus();
    if (width !== 900) await resizeWindow(900);
    expect(shell.panel()?.hasAttribute("data-sheet")).toBe(true);
    if (step === "fold") {
      expect(document.activeElement).toBe(shell.$("#app-right-panel [aria-selected=true]"));
      expect(document.activeElement?.textContent).toBe("Evidence");
      return;
    }
    reply.focus();
    const pressEscape = () =>
      act(async () => {
        reply.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
      });
    const handled = (event: Event) => event.preventDefault();
    reply.addEventListener("keydown", handled);
    await pressEscape();
    reply.removeEventListener("keydown", handled);
    expect(shell.panel()).not.toBeNull();
    await pressEscape();
    expect(shell.panel()).toBeNull();
    expect(document.activeElement).toBe(shell.toggles()[0]);
  });

  it.each([
    [1440, true],
    [900, false],
  ])(
    "reopens a saved open panel at launch at %i px only where it sits inline",
    async (width, open) => {
      savePanes({ open: { rightPanel: true } });
      await resizeWindow(width);
      const shell = await mountShell("#thread/t1", [PARTITION]);
      expect(shell.panel() !== null).toBe(open);
      expect(saved().open.rightPanel).toBe(true);
    },
  );
});

describe("Reading", () => {
  it("draws the scope's place without taking the thread's title", async () => {
    savePanes({ open: { rightPanel: true } });
    const shell = await mountShell("#thread/t1", [PARTITION]);
    const body = await shell.tab("Reading");
    expect(body?.querySelector("[data-view-pane=service]")?.getAttribute("aria-label")).toBe(
      "partition",
    );
    expect(body?.querySelector("[aria-label='How code reaches partition main']")).not.toBeNull();
    expect(body?.textContent).not.toContain("not read");
    expect(shell.title()).toBe("Fix the blob retry test");
  });

  it("says the fork was not read when the sweep holds no home for it", async () => {
    savePanes({ open: { rightPanel: true } });
    const unread = {
      ...fixture,
      services: fixture.services?.filter(({ service }) => service !== "partition"),
    };
    const shell = await mountShell("#thread/t1", [PARTITION], unread);
    const body = await shell.tab("Reading");
    expect(body?.querySelector("[data-quiet=unread]")?.textContent).toBe(
      "⌀ This fork was not read.",
    );
    expect(body?.querySelector("[aria-label='How code reaches partition main']")).toBeNull();
  });

  it.each([
    ["not listed yet", null],
    ["unknown to the host", []],
  ])("says the scope is not known while the thread is %s", async (_, listed) => {
    savePanes({ open: { rightPanel: true } });
    const shell = await mountShell("#thread/t1", listed);
    for (const tab of ["Reading", "Evidence"]) {
      const body = await shell.tab(tab);
      expect(body?.textContent).toBe("⌀ This thread's scope is not known.");
    }
  });
});

describe("Evidence", () => {
  const SENT_AT = "2026-11-02T09:15:00.000Z";
  const sentChip = (id: string, title: string) => ({
    name: `context:${id}`,
    content: JSON.stringify({
      id,
      kind: "item",
      title,
      sweptAt: SENT_AT,
      completeness: "complete",
      notRead: [],
      evidence: [
        {
          source: "github",
          object: "pulls/121",
          observedAt: "2026-11-02T09:10:00.000Z",
          completeness: { kind: "complete" },
        },
        "gitlab entitlements (cut 3/5)",
      ],
    }),
  });
  const journal = (id: string, first: boolean): ThreadWireEvent[] => {
    const base = { threadId: "t1", at: 1 };
    const sent = (sequence: number, attachments: ReturnType<typeof sentChip>[]) => ({
      ...base,
      sequence,
      type: "message.sent" as const,
      messageId: `m${sequence}`,
      message: { prompt: "Why?", ...(attachments.length ? { attachments } : {}) },
    });
    return [
      { ...base, sequence: 1, type: "thread.created", thread: { scope: "entitlements" } },
      sent(2, first ? [sentChip(id, "Saved when sent")] : []),
      sent(3, [sentChip(id, "Refreshed later")]),
    ];
  };

  it.each([
    ["a row a later sweep dropped", "sync-run:gone", true],
    ["a row that survives from an older sweep", "conflict:entitlements:121", true],
    ["no matching attachment on the first message", "conflict:entitlements:121", false],
  ])("draws the starting chip as sent for %s", async (_, subject, attached) => {
    savePanes({ open: { rightPanel: true } });
    const thread = summary({ scope: "entitlements", subject });
    const shell = await mountShell("#thread/t1", [thread], fixture, journal(subject, attached));
    const body = await shell.tab("Evidence");
    const chip = body?.querySelector("[data-evidence-for=chip]");
    if (attached) {
      expect(chip?.querySelector(".evidence-lede")?.textContent).toBe(
        `Saved when sent · sweep ended ${clockTime(SENT_AT, { hint: false })}`,
      );
      expect(
        [...(chip?.querySelectorAll("[data-evidence-part=references] li") ?? [])].map(
          (item) => item.querySelector(".evidence-read-object")?.textContent,
        ),
      ).toEqual(["github · pulls/121", "gitlab entitlements (cut 3/5)"]);
    } else {
      expect(chip?.textContent).toBe("⌀ The chip this thread started from is not available.");
    }
    expect(chip?.querySelector("[data-evidence-part=areas]")).toBeNull();
    const scope = body?.querySelector("[data-evidence-for=scope]");
    expect(scope?.querySelector(".evidence-lede")?.textContent).toBe(
      `entitlements · sweep ended ${clockTime(fixture.sweptAt, { hint: false })}`,
    );
    expect(scope?.querySelector("[aria-label=Areas]")?.querySelectorAll("tr").length).toBe(10);
  });

  it.each([
    ["sync-run:gone", "gone"],
    ["service:partition", "partition"],
  ])("claims nothing for chip %s while its first message is not read", async (subject, scope) => {
    savePanes({ open: { rightPanel: true } });
    const unread = { ...fixture, services: [] };
    const shell = await mountShell("#thread/t1", [summary({ scope, subject })], unread);
    const body = await shell.tab("Evidence");
    expect(body?.querySelector("[data-evidence-for=chip]")?.textContent).toBe(
      "⌀ The chip this thread started from is not available.",
    );
    expect(body?.querySelector("[data-evidence-for=scope] [data-quiet=unread]")?.textContent).toBe(
      "⌀ This fork was not read.",
    );
  });
});

describe("Thread and Changes", () => {
  const HEAD = "c".repeat(40);
  const LANDED = summary({
    scope: "partition",
    title: "Fix the blob retry test",
    landsIn: {
      target: "fork-main",
      branch: "spi/t1",
      baseRef: "refs/remotes/origin/main",
      worktree: "/app/worktrees/thread-t1",
      head: HEAD,
    },
  });
  const read = (uncommitted: boolean, files: unknown[] = []) => ({
    state: "read",
    head: HEAD,
    ahead: 0,
    uncommitted,
    files,
  });
  type Shell = Awaited<ReturnType<typeof mountShell>>;
  const answer = async (shell: Shell, request: string, type: string, payload: object) => {
    const asked = [...shell.posted()].reverse().find((message) => message.type === request);
    if (!asked) throw new Error(`No ${request} was posted`);
    const reply = {
      version: PROTOCOL_VERSION,
      id: asked.id,
      kind: "response",
      type,
      payload: { threadId: "t1", ...payload },
    };
    await act(async () => {
      changesStore.getState().receive({
        ...reply,
      });
      publicationStore.getState().receive(reply);
    });
  };
  const commitButton = (shell: Shell) =>
    [...(shell.panel()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((button) =>
      button.textContent?.startsWith("Commit"),
    );
  async function typeMessage(shell: Shell, text: string) {
    const area = shell.$<HTMLTextAreaElement>("textarea[aria-label='Commit message']");
    if (!area) throw new Error("No commit message box");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        area,
        text,
      );
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("opens on the Thread tab, says an Asking program thread changes no code, and commits nothing", async () => {
    savePanes({ open: { rightPanel: true } });
    const shell = await mountShell("#thread/t1", [summary({ scope: "program" })]);
    expect(shell.$("#app-right-panel [aria-selected=true]")?.textContent).toBe("Thread");
    await answer(shell, "thread.changes", "thread.changes.result", {
      changes: { state: "asking" },
    });
    const body = shell.$("#app-right-panel [role=tabpanel]");
    expect(body?.querySelector("[data-field=lands-in] dd")?.textContent).toMatch(
      /^Asking\. A program thread changes no code\./u,
    );
    expect(commitButton(shell)).toBeUndefined();
    const changes = await shell.tab("Changes");
    await answer(shell, "thread.changes", "thread.changes.result", {
      changes: { state: "asking" },
    });
    expect(changes?.textContent).toContain("has no worktree");
  });

  it("disables Commit while clean, lists both edits after Refresh with their diff, and commits", async () => {
    savePanes({ open: { rightPanel: true } });
    const shell = await mountShell("#thread/t1", [LANDED]);
    await answer(shell, "thread.changes", "thread.changes.result", { changes: read(false) });
    await typeMessage(shell, "Change the answer");
    expect(commitButton(shell)?.disabled).toBe(true);
    expect(shell.$("[data-field=git]")?.textContent).toContain("Nothing to commit.");

    const changes = await shell.tab("Changes");
    expect(changes?.querySelector("h3")?.textContent).toBe("Changes against main");
    const refresh = [...(changes?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Refresh",
    );
    await act(async () => refresh?.click());
    await answer(shell, "thread.changes", "thread.changes.result", {
      changes: read(true, [
        { path: "answer.txt", added: 2, removed: 1, untracked: false },
        { path: "notes/new.txt", added: 2, removed: 0, untracked: true },
      ]),
    });
    const rows = [...(changes?.querySelectorAll(".thread-change") ?? [])];
    expect(rows.map((row) => row.textContent)).toEqual([
      "answer.txt+2 −1",
      "notes/new.txt" + "new · +2 −0",
    ]);
    await act(async () => (rows[0] as HTMLElement).click());
    expect(shell.posted().at(-1)?.payload).toEqual({ threadId: "t1", path: "answer.txt" });
    await answer(shell, "thread.diff", "thread.diff.result", {
      path: "answer.txt",
      diff: { state: "read", patch: "@@ -1,2 +1,3 @@\n-two\n+2\n+four\n", truncated: false },
    });
    expect(
      [...(changes?.querySelectorAll(".thread-diff [data-line]") ?? [])].map((line) =>
        line.getAttribute("data-line"),
      ),
    ).toEqual(["removed", "added", "added"]);

    await shell.tab("Thread");
    await answer(shell, "thread.changes", "thread.changes.result", {
      changes: read(true, [
        { path: "answer.txt", added: 2, removed: 1, untracked: false },
        { path: "notes/new.txt", added: 2, removed: 0, untracked: true },
      ]),
    });
    expect(shell.$("[data-field=lands-in] dd")?.textContent).toContain(
      "spi/t1 · 0 commits · 2 files changed",
    );
    await typeMessage(shell, "Change the answer");
    expect(commitButton(shell)?.disabled).toBe(false);
    await act(async () => commitButton(shell)?.click());
    expect(shell.posted().at(-1)).toMatchObject({
      type: "thread.commit",
      payload: { threadId: "t1", message: "Change the answer" },
    });
    expect(commitButton(shell)?.textContent).toBe("Committing…");
    await answer(shell, "thread.commit", "thread.committed", {
      commit: { outcome: "refused", reason: "A turn is running. Commit when it finishes." },
    });
    expect(shell.$(".thread-commit-outcome")?.textContent).toBe(
      "A turn is running. Commit when it finishes.",
    );
    expect(shell.posted().at(-1)?.type).toBe("thread.changes");
  });

  it("reads the worktree again when the Thread tab is shown after a turn ended elsewhere", async () => {
    savePanes({ open: { rightPanel: true } });
    const shell = await mountShell("#thread/t1", [LANDED]);
    await answer(shell, "thread.changes", "thread.changes.result", { changes: read(false) });
    await shell.tab("Reading");
    const asked = shell.posted().filter(({ type }) => type === "thread.changes").length;
    await act(async () => threadStore.setState({ threads: [{ ...LANDED, status: "Working" }] }));
    await act(async () => threadStore.setState({ threads: [LANDED] }));
    await shell.tab("Thread");
    expect(shell.posted().filter(({ type }) => type === "thread.changes")).toHaveLength(asked + 1);
    await answer(shell, "thread.changes", "thread.changes.result", { changes: read(true) });
    await typeMessage(shell, "Change it");
    expect(commitButton(shell)?.disabled).toBe(false);
  });

  it("offers the right thread for an ownership mismatch without blocking Commit", async () => {
    savePanes({ open: { rightPanel: true } });
    const shell = await mountShell("#thread/t1", [LANDED]);
    const changes = await shell.tab("Changes");
    await answer(shell, "thread.changes", "thread.changes.result", {
      changes: read(true, [
        {
          path: "partition-core/src/Main.java",
          added: 2,
          removed: 1,
          untracked: false,
          owner: "upstream",
        },
        {
          path: "provider/partition-azure/src/Azure.java",
          added: 1,
          removed: 0,
          untracked: false,
          owner: "fork",
        },
        { path: "unknown/file.txt", added: 1, removed: 0, untracked: false },
      ]),
    });
    expect(
      [...(changes?.querySelectorAll(".thread-owner-tag") ?? [])].map((tag) => tag.textContent),
    ).toEqual(["Upstream", "Fork"]);
    expect(changes?.textContent).not.toContain("unknown/file.txtFork");
    expect(changes?.querySelector(".thread-owner-mismatch")?.textContent).toContain(
      "Upstream owns this file. The next sync overwrites a change made here.",
    );
    await shell.tab("Thread");
    await answer(shell, "thread.changes", "thread.changes.result", {
      changes: read(true, [
        {
          path: "partition-core/src/Main.java",
          added: 2,
          removed: 1,
          untracked: false,
          owner: "upstream",
        },
      ]),
    });
    await typeMessage(shell, "Split the change");
    expect(commitButton(shell)?.disabled).toBe(false);
    const refreshed = await shell.tab("Changes");
    await answer(shell, "thread.changes", "thread.changes.result", {
      changes: read(true, [
        {
          path: "partition-core/src/Main.java",
          added: 2,
          removed: 1,
          untracked: false,
          owner: "upstream",
        },
      ]),
    });
    const move = [...(refreshed?.querySelectorAll("button") ?? [])].find((button) =>
      button.textContent?.startsWith("Continue this file"),
    );
    if (!move) throw new Error("No move action");
    await act(async () => move.click());
    expect(threadStore.getState().draft).toMatchObject({
      scope: "partition",
      landsIn: "upstream",
      text: "Continue the change in partition-core/src/Main.java in a thread that lands in Upstream.",
    });
    expect(window.location.hash).toBe("#thread/new");

    expect(shell.$<HTMLTextAreaElement>("textarea[aria-label='Message Copilot']")?.value).toBe(
      "Continue the change in partition-core/src/Main.java in a thread that lands in Upstream.",
    );
    const send = shell.layout.querySelector<HTMLButtonElement>('button[aria-label="Send"]');
    expect(send?.disabled).toBe(false);
    await act(async () => send?.click());
    const start = [...shell.posted()].reverse().find((message) => message.type === "thread.start");
    expect(start?.payload).toMatchObject({ scope: "partition", landsIn: { target: "upstream" } });
  });

  it("says the worktree was not read and offers no commit", async () => {
    savePanes({ open: { rightPanel: true } });
    const shell = await mountShell("#thread/t1", [LANDED]);
    await answer(shell, "thread.changes", "thread.changes.result", {
      changes: { state: "not read", reason: "Git is unavailable." },
    });
    await typeMessage(shell, "Change it");
    expect(commitButton(shell)?.disabled).toBe(true);
    const changes = await shell.tab("Changes");
    await answer(shell, "thread.changes", "thread.changes.result", {
      changes: { state: "not read", reason: "Git is unavailable." },
    });
    expect(changes?.querySelector("[data-quiet=not-read]")?.textContent).toBe(
      "⌀ The worktree was not read. Git is unavailable.",
    );
  });

  it("binds Push to the displayed head, opens the draft result and counts Changes", async () => {
    savePanes({ open: { rightPanel: true } });
    const shell = await mountShell("#thread/t1", [LANDED]);
    await answer(shell, "thread.publication", "thread.publication.result", {
      publication: {
        state: "ready",
        remote: "origin",
        branch: "spi/t1",
        base: "main",
        opens: "pull-request",
      },
    });
    await answer(shell, "thread.changes", "thread.changes.result", {
      changes: {
        ...read(false),
        ahead: 1,
        files: [{ path: "answer.txt", added: 1, removed: 0, untracked: false }],
      },
    });
    expect(shell.panel()?.querySelector('[role="tab"][data-tab="changes"]')?.textContent).toBe(
      "Changes 1",
    );
    const push = [...(shell.panel()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (button) => button.textContent === "Push / Open draft PR",
    );
    expect(push?.disabled).toBe(false);
    await act(async () => push?.click());
    expect(shell.posted().at(-1)).toMatchObject({
      type: "thread.publish",
      payload: { threadId: "t1", head: HEAD },
    });
    await answer(shell, "thread.publish", "thread.published", {
      publication: {
        outcome: "published",
        head: HEAD,
        request: {
          forge: "github",
          repository: "Azure/osdu-spi-partition",
          requestNumber: 42,
          url: "https://github.com/Azure/osdu-spi-partition/pull/42",
        },
      },
    });
    expect(shell.$(".thread-publish-outcome")?.textContent).toContain("Opened draft PR 42");
    expect(shell.$<HTMLAnchorElement>(".thread-publish-outcome a")?.href).toBe(
      "https://github.com/Azure/osdu-spi-partition/pull/42",
    );
  });

  it("shows a request as pending until that URL appears in a sweep", async () => {
    savePanes({ open: { rightPanel: true } });
    const url = "https://github.com/Azure/osdu-spi-partition/pull/42";
    const owned = summary({
      ...LANDED.thread,
      request: {
        forge: "github",
        repository: "Azure/osdu-spi-partition",
        requestNumber: 42,
        url,
      },
    });
    const shell = await mountShell("#thread/t1", [owned]);
    expect(shell.$("[data-field=request]")?.textContent).toContain("Pending until the next sweep");
    await act(async () => {
      watchStore.setState({
        snapshot: {
          cursor: fixture.cursor,
          body: { ...fixture, requestProbe: { url } } as ViewSnapshot,
        },
      });
    });
    expect(shell.$("[data-field=request]")?.textContent).toContain("Owned by this thread");
  });
});
