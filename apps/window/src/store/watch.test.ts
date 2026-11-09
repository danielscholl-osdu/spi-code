// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION, type ViewSnapshot, WatchMessageSchema } from "@spi-code/contracts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import briefing from "../../../../fixtures/rib-59d6895/oracle/briefing.json?raw";
import releases from "../../../../fixtures/rib-59d6895/oracle/releases.json?raw";
import { Shell } from "../app/Shell.js";
import { midSweep } from "../components/sweep/test-helper.js";
import { createSelectionStore } from "../panels/selection.js";
import { testSnapshot as snapshotFromOracles } from "./test-snapshot.js";
import { createWatchStore, selectAreaEnvelopes, selectEnvelopes, watchStore } from "./watch.js";

const testSnapshot = (overrides: Partial<ViewSnapshot> = {}) =>
  snapshotFromOracles(briefing, releases, overrides);

const event = (type: string, payload: unknown) => ({
  version: PROTOCOL_VERSION,
  id: "host",
  kind: "event",
  type,
  payload,
});

it("selects every snapshot area's envelope and none before the first snapshot", () => {
  const store = createWatchStore(vi.fn());
  expect(selectAreaEnvelopes(store.getState())).toEqual([]);
  expect(selectEnvelopes(store.getState())).toEqual([]);
  const body = testSnapshot();
  store.getState().receive(event("view.snapshot", body));
  expect(selectAreaEnvelopes(store.getState())).toEqual(body.areas.map(({ envelope }) => envelope));
  expect(selectEnvelopes(store.getState())).toEqual(selectAreaEnvelopes(store.getState()));
});

it("selects supplemental envelopes alongside every area without inventing absent evidence", () => {
  const store = createWatchStore(vi.fn());
  const envelope = {
    source: "releases",
    state: "failed",
    completeness: { kind: "complete" },
  } as const;
  const body = testSnapshot({
    provenance: [
      { path: "/releases", areas: ["fleet"], envelope },
      { path: "/briefing", areas: ["github"] },
    ],
  });
  store.getState().receive(event("view.snapshot", body));
  expect(selectEnvelopes(store.getState())).toEqual([
    ...selectAreaEnvelopes(store.getState()),
    envelope,
  ]);
});

it("rejects git sign-in at the type and runtime boundaries", () => {
  const send = vi.fn();
  const store = createWatchStore(send);
  expect(() => {
    // @ts-expect-error git is installable but has no sign-in flow.
    store.getState().requestSetup("setup.signin", "git");
  }).toThrow("Invalid setup request");
  expect(send).not.toHaveBeenCalled();
});

it("keeps Check all pending until its correlated completion, not just until send or checkedAt", async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  const store = createWatchStore(send);
  const setup = { tools: [], watchReady: true, disabledReason: null };
  store.getState().receive(event("setup.state", setup));
  await store.getState().requestSetup("setup.check");
  const request = store.getState().setupCheckRequest;
  expect(request).toBe(WatchMessageSchema.parse(send.mock.calls[0]?.[0]).id);
  await store.getState().requestSetup("setup.check");
  expect(send).toHaveBeenCalledTimes(1);
  store.getState().receive(event("setup.state", setup));
  expect(store.getState().setupCheckRequest).toBe(request);
  store
    .getState()
    .receive(event("setup.state", { ...setup, checkedAt: "2026-11-08T15:04:00.000Z" }));
  expect(store.getState().setupCheckRequest).toBe(request);
  store.getState().receive({
    ...event("setup.state", { ...setup, checkedAt: "2026-11-08T15:04:00.000Z" }),
    id: request,
  });
  expect(store.getState().setupCheckRequest).toBeNull();
  await store.getState().requestSetup("setup.check");
  expect(send).toHaveBeenCalledTimes(2);
});

it("unlocks a check on its host error without rendering that error's secrets", () => {
  const store = createWatchStore(vi.fn());
  store.getState().requestSetup("setup.check");
  const id = store.getState().setupCheckRequest;
  const error = {
    version: PROTOCOL_VERSION,
    id: "old-check",
    kind: "response",
    type: "error",
    payload: { code: "host_failed", message: "Failed with ghp_FixtureSecret and ABCD-1234" },
  };
  store.getState().receive(error);
  expect(store.getState().setupCheckRequest).toBe(id);
  store.getState().receive({ ...error, id });
  expect(store.getState().setupCheckRequest).toBeNull();
  expect(store.getState().setupCheckError).toBe("Could not check Watch tools. Try again.");
});

it("clears pending checks and sign-ins before throwing the supervisor's give-up error", () => {
  const store = createWatchStore(vi.fn());
  store.getState().requestSetup("setup.check");
  store.getState().requestSetup("setup.signin", "gh");
  const requestId = store.getState().signinRequest.gh;
  store
    .getState()
    .receive(event("setup.signin.progress", { requestId, tool: "gh", state: "waiting" }));
  expect(store.getState().setupCheckRequest).not.toBeNull();
  expect(store.getState().signinRequest.gh).toBe(requestId);
  const message = "Host stopped after repeated crashes. Restart SPI Code to reconnect.";
  expect(() =>
    store.getState().receive({
      ...event("error", { code: "host_unavailable", message }),
      id: "host-supervisor",
      kind: "response",
    }),
  ).toThrow(message);
  expect(store.getState().setupCheckRequest).toBeNull();
  expect(store.getState().setupCheckError).toBe(message);
  expect(store.getState().signinRequest).toEqual({});
  expect(store.getState().signin).toEqual({});
  expect(store.getState().signinOutcome).toEqual({});
});

it("releases a failed check and does not let an old connection's rejection release a newer one", async () => {
  let rejectSend: (error: Error) => void = () => {};
  const send = vi.fn().mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectSend = reject;
      }),
  );
  const store = createWatchStore(send);
  const first = store.getState().requestSetup("setup.check");
  store.getState().receive(event("host.hello", { pid: 456 }));
  expect(store.getState().setupCheckRequest).toBeNull();
  store.getState().requestSetup("setup.check");
  const newer = store.getState().setupCheckRequest;
  const error = new Error("Old send failed");
  rejectSend(error);
  await expect(first).rejects.toBe(error);
  expect(store.getState().setupCheckRequest).toBe(newer);
  store.getState().receive(event("host.hello", { pid: 789 }));
  send.mockImplementationOnce(() => {
    throw error;
  });
  expect(() => store.getState().requestSetup("setup.check")).toThrow(error);
  expect(store.getState().setupCheckRequest).toBeNull();
});

it("sends cancellation for the original sign-in without dropping its pending progress", () => {
  const send = vi.fn();
  const store = createWatchStore(send);
  store.getState().requestSetup("setup.signin", "gh");
  const requestId = store.getState().signinRequest.gh;
  if (!requestId) throw new Error("Missing sign-in request");
  store.getState().requestSetup("setup.signin.cancel", requestId);
  expect(WatchMessageSchema.parse(send.mock.calls[1]?.[0])).toMatchObject({
    type: "setup.signin.cancel",
    payload: { requestId },
  });
  expect(store.getState().signinRequest.gh).toBe(requestId);
});

it("sends a glab token only with glab sign-in and keeps it out of store state", () => {
  const send = vi.fn();
  const store = createWatchStore(send);
  const token = "glpat-Secret0123456789";
  const before = store.getState();
  store.getState().requestSetup("setup.signin", "glab", token);
  const { signinRequest, ...after } = store.getState();
  const { signinRequest: _unset, ...rest } = before;
  expect(after).toEqual(rest);
  expect(signinRequest).toEqual({ glab: WatchMessageSchema.parse(send.mock.calls[0]?.[0]).id });
  expect(JSON.stringify(store.getState())).not.toContain(token);
  store.getState().requestSetup("setup.signin", "gh");
  expect(send.mock.calls.map(([message]) => WatchMessageSchema.parse(message).payload)).toEqual([
    { tool: "glab", token },
    { tool: "gh" },
  ]);
  expect(JSON.stringify(store.getState())).not.toContain(token);
  expect(() => {
    // @ts-expect-error only glab sign-in carries a token.
    store.getState().requestSetup("setup.signin", "gh", token);
  }).toThrow("Invalid setup request");
  expect(send).toHaveBeenCalledTimes(2);
});

it("applies sign-in progress only for each tool's pending request", () => {
  const send = vi.fn();
  const store = createWatchStore(send);
  const progress = (requestId: string, tool: string, state: string) =>
    store.getState().receive(event("setup.signin.progress", { requestId, tool, state }));
  const sentId = (call: number) => WatchMessageSchema.parse(send.mock.calls[call]?.[0]).id;
  progress("unknown", "gh", "starting");
  expect(store.getState().signin).toEqual({});
  store.getState().requestSetup("setup.signin", "gh");
  store.getState().requestSetup("setup.signin", "glab", "glpat-Secret0123456789");
  const gh = sentId(0);
  const glab = sentId(1);
  progress(glab, "gh", "starting");
  progress(gh, "glab", "starting");
  expect(store.getState().signin).toEqual({});
  progress(gh, "gh", "starting");
  progress(glab, "glab", "starting");
  expect(store.getState().signin).toEqual({
    gh: { requestId: gh, tool: "gh", state: "starting" },
    glab: { requestId: glab, tool: "glab", state: "starting" },
  });
  progress(gh, "gh", "completed");
  expect(store.getState().signinRequest).toEqual({ glab });
  progress(gh, "gh", "starting");
  expect(store.getState().signin.gh).toBeUndefined();
  store.getState().receive(event("host.hello", { pid: 1 }));
  expect(store.getState().signinRequest).toEqual({});
  progress(glab, "glab", "completed");
  expect(store.getState().signinOutcome).toEqual({});
});

it.each(["gh", "copilot"] as const)(
  "keeps the first pending %s sign-in when a second is requested before any progress",
  (tool) => {
    const send = vi.fn();
    const store = createWatchStore(send);
    store.getState().requestSetup("setup.signin", tool);
    store.getState().requestSetup("setup.signin", tool);
    expect(send).toHaveBeenCalledTimes(1);
    const first = WatchMessageSchema.parse(send.mock.calls[0]?.[0]).id;
    expect(store.getState().signinRequest).toEqual({ [tool]: first });
    for (const step of [
      { state: "starting" },
      { state: "device-code", deviceCode: "AAAA-BBBB", url: "https://github.com/login/device" },
    ])
      store.getState().receive(event("setup.signin.progress", { requestId: first, tool, ...step }));
    expect(store.getState().signin[tool]).toMatchObject({ state: "device-code" });
    store
      .getState()
      .receive(event("setup.signin.progress", { requestId: first, tool, state: "completed" }));
    store.getState().requestSetup("setup.signin", tool);
    expect(send).toHaveBeenCalledTimes(2);
  },
);

it.each([
  ["gh", undefined],
  ["glab", "glpat-Secret0123456789"],
] as const)("leaves no pending %s sign-in when the request cannot be sent", (tool, token) => {
  const send = vi.fn().mockImplementationOnce(() => {
    throw new Error("Host port is not connected");
  });
  const store = createWatchStore(send);
  const request = () =>
    tool === "glab"
      ? store.getState().requestSetup("setup.signin", tool, token as string)
      : store.getState().requestSetup("setup.signin", tool);
  expect(request).toThrow("Host port is not connected");
  expect(store.getState().signinRequest).toEqual({});
  request();
  expect(send).toHaveBeenCalledTimes(2);
  expect(store.getState().signinRequest).toEqual({
    [tool]: WatchMessageSchema.parse(send.mock.calls[1]?.[0]).id,
  });
});

it.each(["gh", "glab"] as const)(
  "releases a rejected %s send before allowing a retry without retaining a credential",
  async (tool) => {
    const token = "glpat-Secret0123456789";
    const error = new Error("Host port is not connected");
    const send = vi.fn().mockRejectedValueOnce(error);
    const store = createWatchStore(send);
    const request = () =>
      tool === "glab"
        ? store.getState().requestSetup("setup.signin", tool, token)
        : store.getState().requestSetup("setup.signin", tool);
    await expect(request()).rejects.toBe(error);
    expect(store.getState().signinRequest).toEqual({});
    expect(JSON.stringify(store.getState())).not.toContain(token);
    await request();
    expect(send).toHaveBeenCalledTimes(2);
    expect(store.getState().signinRequest).toEqual({
      [tool]: WatchMessageSchema.parse(send.mock.calls[1]?.[0]).id,
    });
  },
);

it("keeps a new pending sign-in when an old connection's send rejects", async () => {
  let rejectSend: (error: Error) => void = () => {};
  const send = vi.fn().mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectSend = reject;
      }),
  );
  const store = createWatchStore(send);
  const first = store.getState().requestSetup("setup.signin", "gh");
  store.getState().receive(event("host.hello", { pid: 456 }));
  store.getState().requestSetup("setup.signin", "gh");
  const requests = store.getState().signinRequest;
  const error = new Error("Old connection failed");
  rejectSend(error);
  await expect(first).rejects.toBe(error);
  expect(store.getState().signinRequest).toBe(requests);
});

it("keeps the newest full snapshot and ignores late and duplicate cursors", () => {
  const store = createWatchStore(vi.fn());
  const body = testSnapshot({ cursor: 9 });
  for (const payload of [testSnapshot({ cursor: 3 }), body]) {
    store.getState().receive(event("view.snapshot", payload));
  }
  expect(store.getState().snapshot).toEqual({ cursor: 9, body });
  const state = store.getState();
  const changed = vi.fn();
  store.subscribe(changed);
  for (const cursor of [4, 9]) {
    store.getState().receive(event("view.snapshot", testSnapshot({ cursor, tree: [] })));
  }
  expect(store.getState()).toBe(state);
  expect(changed).not.toHaveBeenCalled();
});

it.each([
  ["Briefing", (body: ReturnType<typeof testSnapshot>) => ({ ...body, briefing: {} })],
  [
    "read",
    (body: ReturnType<typeof testSnapshot>) => ({
      ...body,
      reads: [{ ...body.reads[0], observedAt: "not-a-date" }],
    }),
  ],
  [
    "station",
    (body: ReturnType<typeof testSnapshot>) => ({
      ...body,
      stations: [{ service: "legal", stations: [{ id: "upstream", state: "green", text: "" }] }],
    }),
  ],
])("rejects a malformed %s before any store mutation, even at a stale cursor", (_name, corrupt) => {
  const send = vi.fn();
  const store = createWatchStore(send);
  store.getState().receive(event("view.snapshot", testSnapshot({ cursor: 9 })));
  store.getState().select("halt:legal");
  send.mockClear();
  const state = store.getState();
  const changed = vi.fn();
  store.subscribe(changed);
  for (const cursor of [10, 8]) {
    expect(() =>
      store.getState().receive(event("view.snapshot", corrupt(testSnapshot({ cursor })))),
    ).toThrow("Invalid host message");
    expect(store.getState()).toBe(state);
  }
  expect(changed).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

it("sets, retains a vanished selection across snapshots and reset, and clears explicitly", () => {
  const store = createWatchStore(vi.fn());
  expect(store.getState().selection).toBeNull();
  const body = testSnapshot();
  const id = body.briefing.focus[0]?.id;
  expect(id).toBeDefined();
  if (id === undefined) throw new Error("Oracle must contain a focus item");
  store.getState().receive(event("view.snapshot", body));
  store.getState().select(id);
  expect(store.getState().selection).toEqual({ id });
  store.getState().receive(
    event(
      "view.snapshot",
      testSnapshot({
        cursor: 2,
        briefing: { ...body.briefing, focus: [], rest: [] },
        selection: "today",
      }),
    ),
  );
  expect(store.getState().selection).toEqual({ id });
  store.getState().receive(event("host.hello", { pid: 456 }));
  expect(store.getState().selection).toEqual({ id });
  store.getState().select("rollout");
  expect(store.getState().selection).toEqual({ id: "rollout" });
  store.getState().clear();
  expect(store.getState().selection).toBeNull();
  expect(store.getState().snapshot?.cursor).toBe(2);
});

it("forwards select and clear to the inspector selection, its one source", () => {
  const postMessage = vi.fn();
  const inspector = createSelectionStore({ postMessage });
  inspector.getState().select("halt:legal");
  const store = createWatchStore(vi.fn(), inspector);
  expect(store.getState().selection).toEqual({ id: "halt:legal" });
  store.getState().select("rollout");
  expect(inspector.getState().selected).toBe("rollout");
  expect(postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "inspect.request", payload: { id: "rollout" } }),
  );
  inspector.getState().select("halt:entitlements");
  expect(store.getState().selection).toEqual({ id: "halt:entitlements" });
  store.getState().clear();
  expect(inspector.getState().selected).toBeNull();
  expect(store.getState().selection).toBeNull();
});

it("subscribes on every hello with zero initially and the last cursor after reset", () => {
  const send = vi.fn();
  const store = createWatchStore(send);
  store.getState().receive(event("host.hello", { pid: 123 }));
  store.getState().receive(event("view.snapshot", testSnapshot({ cursor: 0 })));
  store.getState().receive(event("view.snapshot", testSnapshot({ cursor: 12 })));
  expect(store.getState().epoch).toBe(1);
  store.getState().receive(event("host.hello", { pid: 456 }));
  expect(store.getState().epoch).toBe(2);
  expect(send.mock.calls.map(([message]) => WatchMessageSchema.parse(message).payload)).toEqual([
    { fromCursor: 0 },
    { fromCursor: 12 },
  ]);
  expect(send.mock.calls[0]?.[0].id).not.toBe(send.mock.calls[1]?.[0].id);
});

it("keeps the mounted snapshot across reconnect and shows the supervisor's schema-valid give-up error", async () => {
  const previous = window.spi;
  const previousState = watchStore.getState();
  const listeners = new Set<(message: unknown) => void>();
  const postMessage = vi.fn();
  window.spi = {
    proof: false,
    openExternal: vi.fn(),
    postMessage,
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  watchStore.setState({ snapshot: null });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const receive = async (message: unknown) =>
    act(async () => {
      for (const listener of listeners) listener(message);
    });
  try {
    await act(async () => root.render(createElement(Shell)));
    await receive(event("view.snapshot", testSnapshot({ cursor: 12 })));
    const mountedView = container.querySelector("main h1");
    expect(mountedView).not.toBeNull();
    await receive(event("host.hello", { pid: 456 }));
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "view.subscribe", payload: { fromCursor: 12 } }),
    );
    expect(watchStore.getState().snapshot?.cursor).toBe(12);
    expect(container.querySelector("main h1")).toBe(mountedView);
    await receive({
      version: PROTOCOL_VERSION,
      id: "host-supervisor",
      kind: "response",
      type: "error",
      payload: {
        code: "host_unavailable",
        message: "Host stopped after repeated crashes. Restart SPI Code to reconnect.",
      },
    });
    expect(container.querySelector('main > p[role="alert"]')?.textContent).toBe(
      "Host stopped after repeated crashes. Restart SPI Code to reconnect.",
    );
    expect(watchStore.getState().snapshot?.cursor).toBe(12);
    expect(container.querySelector("main h1")).toBe(mountedView);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    watchStore.setState(previousState);
    window.spi = previous;
  }
});

it("keeps the latest cursorless sweep and setup states independently of snapshots", () => {
  const store = createWatchStore(vi.fn());
  const sweep = {
    remaining: 500,
    resetAt: null,
    deferredAreas: [],
    nextSweepAt: null,
    schedule: {
      sweepMs: 300_000,
      gitlabMs: 1_800_000,
      securityMs: 1_800_000,
      releasesMs: 3_600_000,
    },
    lastSweep: null,
  };
  const setup = { tools: [], watchReady: false, disabledReason: "Install git" };
  store.getState().receive(event("sweep.status", { ...sweep, remaining: 1000 }));
  store
    .getState()
    .receive(event("setup.state", { ...setup, watchReady: true, disabledReason: null }));
  store.getState().receive(event("view.snapshot", testSnapshot({ cursor: 9 })));
  store.getState().receive(event("sweep.status", sweep));
  store.getState().receive(event("setup.state", setup));
  store.getState().receive(event("view.snapshot", testSnapshot({ cursor: 1 })));
  expect(store.getState()).toMatchObject({ sweep, setup, snapshot: { cursor: 9 } });
  expect(() => store.getState().receive(event("sweep.status", {}))).toThrow("Invalid host");
  expect(() => store.getState().receive(event("view.snapshot", { cursor: -1 }))).toThrow(
    "Invalid host",
  );
});

it("keeps the latest sweep.progress and the last committed list past the hand-over", () => {
  const store = createWatchStore(vi.fn());
  const running = midSweep();
  const committed = midSweep({
    outcome: "committed",
    sources: running.sources.map((source) =>
      source.state === "reading" || source.state === "waiting"
        ? { source: source.source, state: "read" }
        : source,
    ),
  });
  store.getState().receive(event("sweep.progress", running));
  expect(store.getState()).toMatchObject({ progress: running, completed: null });
  store.getState().receive(event("sweep.progress", committed));
  store.getState().receive(event("view.snapshot", testSnapshot({ cursor: 9 })));
  const later = midSweep({ sweep: "sweep-2", first: false });
  store.getState().receive(event("sweep.progress", later));
  expect(store.getState()).toMatchObject({ progress: later, completed: committed });
  expect(() =>
    store.getState().receive(event("sweep.progress", { ...running, outcome: "done" })),
  ).toThrow("Invalid host");
});

it("asks for a sweep with an empty sweep.request", async () => {
  const send = vi.fn();
  const store = createWatchStore(send);
  await store.getState().requestSweep();
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "request", type: "sweep.request", payload: {} }),
  );
  expect(WatchMessageSchema.safeParse(send.mock.calls[0]?.[0]).success).toBe(true);
});
