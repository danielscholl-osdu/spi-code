// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  PROTOCOL_VERSION,
  SetupSigninSchema,
  type SetupState,
  signinRunningReason,
  WatchMessageSchema,
} from "@spi-code/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Shell } from "../../app/Shell.js";
import { watchStore } from "../../store/watch.js";
import Setup from "./index.js";

type Tool = SetupState["tools"][number];
const tools: Tool["tool"][] = ["copilot", "git", "gh", "glab"];
let container: HTMLDivElement;
let root: Root;
let previous: Window["spi"];
const send = vi.fn();
const unhandled = vi.fn();

beforeEach(() => {
  unhandled.mockClear();
  window.addEventListener("error", unhandled);
  window.addEventListener("unhandledrejection", unhandled);
  process.on("unhandledRejection", unhandled);
  window.location.hash = "";
  previous = window.spi;
  window.spi = {
    proof: false,
    openExternal: vi.fn(),
    postMessage: send,
    onMessage: () => () => {},
  };
  send.mockClear();
  watchStore.setState({
    setup: null,
    sweep: null,
    snapshot: null,
    signin: {},
    signinOutcome: {},
    signinRequest: {},
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  window.removeEventListener("error", unhandled);
  window.removeEventListener("unhandledrejection", unhandled);
  process.off("unhandledRejection", unhandled);
  await act(async () => root.unmount());
  container.remove();
  watchStore.setState({
    setup: null,
    sweep: null,
    snapshot: null,
    signin: {},
    signinOutcome: {},
    signinRequest: {},
  });
  vi.restoreAllMocks();
  window.spi = previous;
});
const render = (node: ReactNode = <Setup />) => act(async () => root.render(node));
const receive = (type: string, payload: unknown) =>
  act(async () => {
    watchStore
      .getState()
      .receive({ version: PROTOCOL_VERSION, kind: "event", id: "host", type, payload });
  });
type SigninTool = "copilot" | "gh" | "glab";
/** Host progress for the tool's pending request, or for `requestId` when given. */
const progress = (
  payload: { tool: SigninTool; state: string; [key: string]: unknown },
  requestId = watchStore.getState().signinRequest[payload.tool],
) => receive("setup.signin.progress", { requestId, ...payload });
/** Marks sign-ins pending for tests that start from host progress rather than a click. */
const pending = (requests: Partial<Record<SigninTool, string>>) =>
  act(async () => {
    watchStore.setState({ signinRequest: { ...watchStore.getState().signinRequest, ...requests } });
  });
const state = (overrides: Partial<Tool> = {}): SetupState => ({
  watchReady: false,
  disabledReason: "Sign in to gh with repo and workflow scopes",
  tools: tools.map((tool) => ({ tool, state: "ready", action: null, ...overrides })),
});

const cases: [Tool["state"], Tool["action"], string][] = [
  ["missing", "install", "Missing"],
  ["installing", "install", "Installing"],
  ["ready", null, "Ready"],
  ["needs-update", "install", "Needs update"],
  ["failed", "attention", "Failed"],
  ["signed-out", "signin", "Signed out"],
  ["scope-missing", "signin", "Scope missing"],
  ["no-seat", "attention", "No Copilot seat"],
  ["classic-token", "attention", "Classic ghp_ token"],
];
it.each(cases)(
  "shows one state and at most one action per tool: %s",
  async (status, action, label) => {
    await receive("setup.state", state({ state: status, action }));
    await render();
    for (const name of ["Copilot", "git", "gh", "glab"]) {
      const row = container.querySelector(`section[aria-label="${name}"]`);
      expect(row?.querySelector("p")?.textContent).toBe(label);
      const buttons = row?.querySelectorAll<HTMLButtonElement>("button");
      const offered = action && !(name === "git" && action === "signin");
      expect(buttons).toHaveLength(offered ? 1 : 0);
      const tokenless = name === "glab" && action === "signin";
      if (offered) expect(buttons?.[0]?.disabled).toBe(status === "installing" || tokenless);
    }
  },
);

it("sends validated install and sign-in requests through the shared store port", async () => {
  const setup = state();
  setup.tools[1] = { tool: "git", state: "missing", action: "install" };
  setup.tools[2] = {
    tool: "gh",
    state: "scope-missing",
    action: "signin",
    missingScopes: ["workflow"],
  };
  await receive("setup.state", setup);
  await render();
  for (const button of container.querySelectorAll<HTMLButtonElement>("button")) {
    await act(async () => button.click());
  }
  expect(
    send.mock.calls.map(([message]) => {
      const parsed = WatchMessageSchema.parse(message);
      return { type: parsed.type, payload: parsed.payload };
    }),
  ).toEqual([
    { type: "setup.install", payload: { tool: "git" } },
    { type: "setup.signin", payload: { tool: "gh" } },
  ]);
  expect(container.textContent).toContain("Required scopes: workflow");
});

it.each([
  ["git", "setup.install", "install", "missing", "throws"],
  ["git", "setup.install", "install", "missing", "rejects"],
  ["gh", "setup.signin", "signin", "signed-out", "throws"],
  ["gh", "setup.signin", "signin", "signed-out", "rejects"],
  ["copilot", "setup.signin", "signin", "signed-out", "throws"],
  ["copilot", "setup.signin", "signin", "signed-out", "rejects"],
] as const)(
  "shows an inline error and resends when %s %s (%s, %s) send %s",
  async (tool, type, action, status, failure) => {
    send.mockImplementationOnce(() => {
      const error = new Error("Host port is not connected");
      if (failure === "throws") throw error;
      return Promise.reject(error);
    });
    const setup = state();
    setup.tools = setup.tools.map((row) =>
      row.tool === tool ? { tool, state: status, action } : row,
    );
    await receive("setup.state", setup);
    await render();
    const row = container.querySelector(
      `section[aria-label="${tool === "copilot" ? "Copilot" : tool}"]`,
    );
    const button = () => row?.querySelector<HTMLButtonElement>("button");
    await act(async () => {
      button()?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(row?.querySelector('[role="alert"]')?.textContent).toContain(
      "Host port is not connected",
    );
    expect(button()?.textContent).toBe("Try again");
    expect(button()?.disabled).toBe(false);
    expect(watchStore.getState().signinRequest).toEqual({});
    await act(async () => button()?.click());
    expect(sent()).toEqual([
      { type, payload: { tool } },
      { type, payload: { tool } },
    ]);
    expect(row?.querySelector('[role="alert"]')).toBeNull();
    expect(button()?.textContent).toBe(action === "install" ? "Install" : "Sign in");
    expect(button()?.disabled).toBe(action === "signin");
    expect(unhandled).not.toHaveBeenCalled();
  },
);

const token = "glpat-Secret0123456789";
const glab = () => {
  const row = container.querySelector('section[aria-label="glab"]');
  const field = row?.querySelector<HTMLInputElement>("input");
  const button = row?.querySelector<HTMLButtonElement>("button");
  if (!row || !field || !button) throw new Error("glab row needs a token field and Sign in");
  return { row, field, button };
};
const paste = (value: string) =>
  act(async () => {
    const { field } = glab();
    field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
const submit = () =>
  act(async () => {
    glab()
      .row.querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
type Fiber = {
  memoizedState: unknown;
  memoizedProps: unknown;
  child: Fiber | null;
  sibling: Fiber | null;
};
/** Every string held in React hook state and props under the test root. */
const reactStrings = () => {
  const key = Object.keys(container).find((name) => name.startsWith("__reactContainer$"));
  const strings: string[] = [];
  const seen = new WeakSet<object>();
  const visit = (value: unknown, depth: number) => {
    if (typeof value === "string") strings.push(value);
    if (depth > 8 || !value || typeof value !== "object" || value instanceof Node) return;
    if (seen.has(value)) return;
    seen.add(value);
    for (const item of Object.values(value)) visit(item, depth + 1);
  };
  const fibers = [(container as unknown as Record<string, Fiber>)[key ?? ""]];
  for (let fiber = fibers.pop(); fiber; fiber = fibers.pop()) {
    visit(fiber.memoizedState, 0);
    visit(fiber.memoizedProps, 0);
    if (fiber.child) fibers.push(fiber.child);
    if (fiber.sibling) fibers.push(fiber.sibling);
  }
  return strings.join("\n");
};
const sent = () =>
  send.mock.calls.map(([message]) => {
    const parsed = WatchMessageSchema.parse(message);
    return { type: parsed.type, payload: parsed.payload };
  });

it("sends the pasted glab token with Sign in as a schema-valid setup.signin", async () => {
  await receive("setup.state", state({ state: "signed-out", action: "signin" }));
  await render();
  await paste(` ${token} `);
  await act(async () => glab().button.click());
  expect(sent()).toEqual([{ type: "setup.signin", payload: { tool: "glab", token } }]);
  expect(SetupSigninSchema.parse(sent()[0]?.payload)).toEqual({ tool: "glab", token });
});

it.each(["", "   "])("keeps Sign in disabled and sends nothing for token %j", async (value) => {
  await receive("setup.state", state({ state: "signed-out", action: "signin" }));
  await render();
  expect(glab().button.disabled).toBe(true);
  await paste(value);
  expect(glab().button.disabled).toBe(true);
  await act(async () => glab().button.click());
  expect(send).not.toHaveBeenCalled();
});

it.each(["", "   "])("ignores a direct form submit of token %j silently", async (value) => {
  await receive("setup.state", state({ state: "signed-out", action: "signin" }));
  await render();
  await paste(value);
  await submit();
  expect(send).not.toHaveBeenCalled();
  expect(glab().row.querySelector('[role="alert"]')).toBeNull();
});

it.each([
  ["short", "Too small"],
  ["glpat-abc def12345", "Credential must not contain whitespace"],
])("shows the schema error for %j without sending and clears the field", async (value, error) => {
  await receive("setup.state", state({ state: "signed-out", action: "signin" }));
  await render();
  await paste(value);
  await act(async () => glab().button.click());
  expect(send).not.toHaveBeenCalled();
  expect(glab().row.querySelector('[role="alert"]')?.textContent).toContain(error);
  expect(glab().row.textContent).not.toContain(value);
  expect(glab().field.value).toBe("");
  expect(glab().button.disabled).toBe(true);
});

it("never echoes, logs, stores or persists the glab token, and clears it on success and failure", async () => {
  const logs = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    vi.spyOn(console, method),
  );
  const persist = vi.spyOn(Storage.prototype, "setItem");
  await receive("setup.state", state({ state: "signed-out", action: "signin" }));
  await render();
  const { field } = glab();
  expect(field.type).toBe("password");
  expect(field.autocomplete).toBe("off");
  expect(field.getAttribute("autocomplete")).toBe("off");
  for (const outcome of [
    { tool: "glab", state: "failed", reason: "GitLab rejected the token" } as const,
    { tool: "glab", state: "completed" } as const,
  ]) {
    send.mockClear();
    await paste(token);
    expect(reactStrings()).not.toContain(token);
    expect(container.innerHTML).not.toContain(token);
    expect(JSON.stringify(watchStore.getState())).not.toContain(token);
    await act(async () => glab().button.click());
    expect(reactStrings()).not.toContain(token);
    expect(JSON.stringify(watchStore.getState())).not.toContain(token);
    expect(sent()).toEqual([{ type: "setup.signin", payload: { tool: "glab", token } }]);
    expect(glab().field.value).toBe("");
    expect(glab().button.disabled).toBe(true);
    await progress({ tool: "glab", state: "starting" });
    expect(glab().field.disabled).toBe(true);
    await progress(outcome);
    if (outcome.state === "failed") {
      expect(glab().row.querySelector('[role="alert"]')?.textContent).toBe(
        "glab sign-in failed. Check the GitLab token and try again.",
      );
      expect(container.textContent).not.toContain(outcome.reason);
    }
    expect(glab().field.disabled).toBe(false);
    expect(glab().field.value).toBe("");
    expect(container.innerHTML).not.toContain(token);
    expect(JSON.stringify(watchStore.getState())).not.toContain(token);
  }
  expect(container.textContent).toContain("Sign-in completed");
  expect(persist).not.toHaveBeenCalled();
  for (const storage of [localStorage, sessionStorage]) {
    const stored = Array.from({ length: storage.length }, (_, index) => {
      const key = storage.key(index) ?? "";
      return `${key}=${storage.getItem(key)}`;
    });
    expect(stored.join("\n")).not.toContain(token);
  }
  for (const log of logs) expect(JSON.stringify(log.mock.calls)).not.toContain(token);
});

it.each(["failed", "completed"])(
  "locks the field once a token is sent and clears a token pasted before %s",
  async (end) => {
    const late = "glpat-LateToken0123456789";
    await receive("setup.state", state({ state: "signed-out", action: "signin" }));
    await render();
    await paste(token);
    await act(async () => glab().button.click());
    expect(glab().field.disabled).toBe(true);
    await paste(late);
    expect(glab().button.disabled).toBe(true);
    await act(async () => glab().button.click());
    expect(sent()).toHaveLength(1);
    await progress({ tool: "glab", state: "starting" });
    await progress(
      end === "failed"
        ? { tool: "glab", state: end, reason: "Rejected" }
        : { tool: "glab", state: end },
    );
    expect(glab().field.value).toBe("");
    expect(glab().field.disabled).toBe(false);
    expect(glab().button.disabled).toBe(true);
  },
);

it("stays locked across an identical setup refresh before any sign-in progress", async () => {
  await receive("setup.state", state({ state: "signed-out", action: "signin" }));
  await render();
  await paste(token);
  await act(async () => glab().button.click());
  await receive("setup.state", state({ state: "signed-out", action: "signin" }));
  expect(glab().field.disabled).toBe(true);
  expect(glab().button.disabled).toBe(true);
  await paste("glpat-LateToken0123456789");
  await submit();
  expect(sent()).toHaveLength(1);
});

it("unlocks and empties the field on host.hello alone before any sign-in progress", async () => {
  await receive("setup.state", state({ state: "signed-out", action: "signin" }));
  await render();
  await paste(token);
  await act(async () => glab().button.click());
  expect(glab().field.disabled).toBe(true);
  await paste("glpat-LateToken0123456789");
  await receive("host.hello", { pid: 456 });
  expect(glab().field.disabled).toBe(false);
  expect(glab().field.value).toBe("");
  expect(glab().button.disabled).toBe(true);
});

const OLD = "req-before-reconnect";
const stale: [string, { tool: SigninTool; state: string; [key: string]: unknown }][] = [
  ["starting", { tool: "glab", state: "starting" }],
  ["waiting", { tool: "glab", state: "waiting" }],
  ["completed", { tool: "glab", state: "completed" }],
  ["failed", { tool: "glab", state: "failed", reason: "Old flow failed" }],
];
it.each(stale)(
  "ignores an old glab flow's %s after host.hello before any new sign-in",
  async (_state, payload) => {
    const typed = "glpat-Typed0123456789";
    await receive("setup.state", state({ state: "signed-out", action: "signin" }));
    await render();
    await pending({ glab: OLD });
    await receive("host.hello", { pid: 456 });
    await paste(typed);
    await progress(payload, OLD);
    expect(glab().field.disabled).toBe(false);
    expect(glab().field.value).toBe(typed);
    expect(glab().button.disabled).toBe(false);
    expect(glab().row.querySelector('[role="status"], [role="alert"]')).toBeNull();
    expect(watchStore.getState().signin.glab).toBeUndefined();
    expect(watchStore.getState().signinOutcome.glab).toBeUndefined();
  },
);

it.each(stale)(
  "ignores an old glab flow's %s that arrives after a new glab sign-in, then applies the new one",
  async (_state, payload) => {
    await receive("setup.state", state({ state: "signed-out", action: "signin" }));
    await render();
    await pending({ glab: OLD });
    await receive("host.hello", { pid: 456 });
    await paste(token);
    await act(async () => glab().button.click());
    expect(glab().field.disabled).toBe(true);
    await progress(payload, OLD);
    expect(glab().field.disabled).toBe(true);
    expect(glab().button.disabled).toBe(true);
    expect(glab().row.querySelector('[role="status"], [role="alert"]')).toBeNull();
    expect(watchStore.getState().signin.glab).toBeUndefined();
    expect(watchStore.getState().signinOutcome.glab).toBeUndefined();
    await progress({ tool: "glab", state: "starting" });
    expect(watchStore.getState().signin.glab?.state).toBe("starting");
    await progress({ tool: "glab", state: "failed", reason: "Rejected" });
    expect(glab().row.querySelector('[role="alert"]')?.textContent).toBe(
      "glab sign-in failed. Check the GitLab token and try again.",
    );
    expect(glab().field.disabled).toBe(false);
  },
);

const ghStale = (["copilot", "gh"] as const).flatMap((tool) =>
  [
    { state: "starting" },
    { state: "device-code", deviceCode: "OLD-CODE", url: "https://github.com/login/device" },
    { state: "waiting" },
    { state: "completed" },
    { state: "failed", reason: "Old flow failed" },
  ].map((step) => [tool, step.state, { tool, ...step }] as const),
);
it.each(ghStale)(
  "ignores an old %s flow's %s after host.hello and after a new sign-in",
  async (tool, _state, payload) => {
    const name = tool === "copilot" ? "Copilot" : "gh";
    const button = () =>
      container.querySelector<HTMLButtonElement>(`section[aria-label="${name}"] button`);
    await receive("setup.state", state({ state: "signed-out", action: "signin" }));
    await render();
    await pending({ [tool]: OLD });
    await receive("host.hello", { pid: 456 });
    await progress(payload, OLD);
    expect(watchStore.getState().signin[tool]).toBeUndefined();
    expect(watchStore.getState().signinOutcome[tool]).toBeUndefined();
    expect(button()?.disabled).toBe(false);
    await act(async () => button()?.click());
    await progress(payload, OLD);
    expect(watchStore.getState().signin[tool]).toBeUndefined();
    expect(watchStore.getState().signinOutcome[tool]).toBeUndefined();
    expect(container.textContent).not.toContain("OLD-CODE");
    expect(container.textContent).not.toContain("Old flow failed");
    await progress({ tool, state: "starting" });
    expect(watchStore.getState().signin[tool]?.state).toBe("starting");
    expect(button()?.disabled).toBe(true);
  },
);

it("keeps Copilot and gh sign-in tokenless with no token field", async () => {
  await receive("setup.state", state({ state: "signed-out", action: "signin" }));
  await render();
  for (const name of ["Copilot", "gh"]) {
    const row = container.querySelector(`section[aria-label="${name}"]`);
    expect(row?.querySelector("input")).toBeNull();
    await act(async () => row?.querySelector<HTMLButtonElement>("button")?.click());
  }
  expect(container.querySelector('section[aria-label="git"] input')).toBeNull();
  expect(sent()).toEqual([
    { type: "setup.signin", payload: { tool: "copilot" } },
    { type: "setup.signin", payload: { tool: "gh" } },
  ]);
});

it.each([
  ["copilot", "Copilot"],
  ["gh", "gh"],
] as const)(
  "disables %s Sign in as soon as it is clicked and keeps the first flow's device code",
  async (tool, name) => {
    await receive("setup.state", state({ state: "signed-out", action: "signin" }));
    await render();
    const button = () =>
      container.querySelector<HTMLButtonElement>(`section[aria-label="${name}"] button`);
    await act(async () => button()?.click());
    expect(button()?.disabled).toBe(true);
    await act(async () => button()?.click());
    expect(sent()).toEqual([{ type: "setup.signin", payload: { tool } }]);
    await progress({ tool, state: "starting" });
    await progress({
      tool,
      state: "device-code",
      deviceCode: "AAAA-BBBB",
      url: "https://github.com/login/device",
    });
    expect(container.querySelector<HTMLInputElement>("input[readonly]")?.value).toBe("AAAA-BBBB");
    await progress({ tool, state: "failed", reason: "Device code expired" });
    expect(button()?.disabled).toBe(false);
  },
);

it.each(["throws", "rejects"])(
  "keeps the glab form usable and its token private when the sign-in send %s",
  async (failure) => {
    send.mockImplementationOnce(() => {
      const error = new Error(`Host port is not connected: ${token}`);
      if (failure === "throws") throw error;
      return Promise.reject(error);
    });
    await receive("setup.state", state({ state: "signed-out", action: "signin" }));
    await render();
    await paste(token);
    await act(async () => glab().button.click());
    expect(glab().row.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not send the sign-in to SPI Code. Try again.",
    );
    expect(glab().field.disabled).toBe(false);
    expect(glab().field.value).toBe("");
    expect(watchStore.getState().signinRequest).toEqual({});
    expect(JSON.stringify(watchStore.getState())).not.toContain(token);
    expect(container.innerHTML).not.toContain(token);
    await paste(token);
    expect(glab().button.disabled).toBe(false);
    await act(async () => glab().button.click());
    expect(send).toHaveBeenCalledTimes(2);
    expect(glab().field.disabled).toBe(true);
    expect(glab().row.querySelector('[role="alert"]')).toBeNull();
    expect(unhandled).not.toHaveBeenCalled();
  },
);

it("shows the host's reason when a glab sign-in is already running", async () => {
  await receive("setup.state", state({ state: "signed-out", action: "signin" }));
  await render();
  await paste(token);
  await act(async () => glab().button.click());
  await progress({ tool: "glab", state: "failed", reason: signinRunningReason("glab") });
  expect(glab().row.querySelector('[role="alert"]')?.textContent).toBe(
    "A glab sign-in is already running.",
  );
  expect(glab().field.disabled).toBe(false);
});

it("shows attention explanations immediately and sends a re-check without toggling", async () => {
  await receive("setup.state", state({ state: "classic-token", action: "attention" }));
  await render();
  const row = container.querySelector('section[aria-label="Copilot"]');
  const button = row?.querySelector<HTMLButtonElement>("button");
  expect(row?.textContent).toContain("gh OAuth browser sign-in");
  expect(button?.hasAttribute("aria-expanded")).toBe(false);
  for (let attempt = 0; attempt < 2; attempt++) {
    await act(async () => button?.click());
    expect(row?.textContent).toContain("gh OAuth browser sign-in");
  }
  expect(sent()).toEqual([
    { type: "setup.check", payload: {} },
    { type: "setup.check", payload: {} },
  ]);
});

it("always shows a supplied attention reason only once", async () => {
  await receive(
    "setup.state",
    state({ state: "failed", action: "attention", reason: "Install failed" }),
  );
  await render();
  const row = container.querySelector('section[aria-label="Copilot"]');
  expect(row?.textContent?.split("Install failed")).toHaveLength(2);
  await act(async () => row?.querySelector<HTMLButtonElement>("button")?.click());
  expect(row?.textContent?.split("Install failed")).toHaveLength(2);
});

it("drops a send error on reconnect and keeps a late rejection tied to the old connection", async () => {
  let rejectSend: (error: Error) => void = () => {};
  send.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectSend = reject;
      }),
  );
  await receive("setup.state", state({ state: "signed-out", action: "signin" }));
  await render();
  const row = container.querySelector('section[aria-label="gh"]');
  const button = () => row?.querySelector<HTMLButtonElement>("button");
  await act(async () => button()?.click());
  expect(button()?.disabled).toBe(true);
  await receive("host.hello", { pid: 456 });
  send.mockImplementationOnce(() => {
    throw new Error("New connection is not ready");
  });
  await act(async () => button()?.click());
  expect(row?.querySelector('[role="alert"]')?.textContent).toContain(
    "New connection is not ready",
  );
  await act(async () => rejectSend(new Error("Old connection failed")));
  expect(row?.querySelector('[role="alert"]')?.textContent).toContain(
    "New connection is not ready",
  );
  await receive("host.hello", { pid: 789 });
  expect(row?.querySelector('[role="alert"]')).toBeNull();
  expect(button()?.disabled).toBe(false);
});

it("shows live device codes and URLs independently for each tool, then errors and completion", async () => {
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await receive("setup.state", state({ state: "signed-out", action: "signin" }));
  await render();
  await pending({ gh: "req-gh", glab: "req-glab" });
  await progress({
    tool: "gh",
    state: "device-code",
    deviceCode: "ABCD-1234",
    url: "https://github.com/login/device",
  });
  await progress({ tool: "glab", state: "starting" });
  const fields = container.querySelectorAll<HTMLInputElement>("input[readonly]");
  expect(Array.from(fields, (field) => field.value)).toEqual([
    "ABCD-1234",
    "https://github.com/login/device",
  ]);
  expect(container.querySelector('a[target="_blank"]')).toBeNull();
  for (const button of container.querySelectorAll<HTMLButtonElement>("button")) {
    if (button.textContent?.startsWith("Copy ")) await act(async () => button.click());
  }
  expect(copy.mock.calls).toEqual([["ABCD-1234"], ["https://github.com/login/device"]]);
  expect(
    container.querySelector<HTMLButtonElement>('section[aria-label="gh"] button')?.disabled,
  ).toBe(true);
  await progress({ tool: "gh", state: "waiting" });
  expect(container.querySelector<HTMLInputElement>("input")?.value).toBe("ABCD-1234");
  await progress({
    tool: "gh",
    state: "failed",
    reason: "Device code expired",
  });
  expect(container.querySelector('section[aria-label="gh"] [role="alert"]')?.textContent).toBe(
    "Device code expired",
  );
  expect(container.querySelector("input[readonly]")).toBeNull();
  expect(watchStore.getState().signin.gh).toBeUndefined();
  expect(
    container.querySelector<HTMLButtonElement>('section[aria-label="gh"] button')?.disabled,
  ).toBe(false);
  await progress({ tool: "glab", state: "completed" });
  expect(container.textContent).toContain("Sign-in completed");
  expect(watchStore.getState().signin.glab).toBeUndefined();
});

it("clears interrupted sign-in on reconnect so Sign in is enabled again", async () => {
  await receive("setup.state", state({ state: "signed-out", action: "signin" }));
  await pending({ gh: "req-gh" });
  await progress({
    tool: "gh",
    state: "device-code",
    deviceCode: "OLD-CODE",
    url: "https://github.com/login/device",
  });
  await render();
  expect(
    container.querySelector<HTMLButtonElement>('section[aria-label="gh"] button')?.disabled,
  ).toBe(true);
  await receive("host.hello", { pid: 456 });
  expect(watchStore.getState().signin).toEqual({});
  expect(watchStore.getState().signinOutcome).toEqual({});
  expect(container.querySelector("input[readonly]")).toBeNull();
  expect(
    container.querySelector<HTMLButtonElement>('section[aria-label="gh"] button')?.disabled,
  ).toBe(false);
});

it("reports clipboard failures with a manual copy fallback", async () => {
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Denied"));
  await receive("setup.state", state());
  await pending({ gh: "req-gh" });
  await progress({
    tool: "gh",
    state: "device-code",
    deviceCode: "CODE",
    url: "https://github.com/login/device",
  });
  await render();
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (item) => item.textContent === "Copy Device code",
  );
  await act(async () => button?.click());
  expect(container.textContent).toContain("Could not copy. Select and copy the text manually.");
});
it.each([0, 9, 10, 11])("flags points only below the reported floor: %s", async (remaining) => {
  await receive("sweep.status", { remaining, floor: 10, resetAt: null, deferredAreas: [] });
  await render();
  const budget = container.querySelector('section[aria-label="GraphQL budget"]');
  expect(budget?.textContent).toContain(`Points left: ${remaining}`);
  expect(budget?.querySelector('[role="alert"]') !== null).toBe(remaining < 10);
});

it("distinguishes an unknown budget and floor from zero", async () => {
  await render();
  expect(container.textContent).toContain("Points left: unknown");
  expect(container.textContent).toContain("Pacer floor not reported");
});

it("lands on Setup when the first host state is not ready and gates every Watch route with its reason", async () => {
  await render(<Shell />);
  await receive("setup.state", state());
  expect(container.querySelector("main h1")?.textContent).toBe("Setup");
  expect(container.querySelector('nav [aria-current="page"]')?.textContent).toBe("Setup");
  const watchRoutes = [...container.querySelectorAll<HTMLButtonElement>("nav ul button")].filter(
    (button) => button.textContent !== "Setup" && button.dataset.sidebarRow !== "line",
  );
  expect(watchRoutes.map((button) => button.textContent)).toEqual([
    "Today",
    "Upstream",
    "Environment",
    "Engineering system",
    "Releases",
    "Security",
  ]);
  for (const button of watchRoutes) {
    await act(async () => button.click());
    expect(container.querySelector("main h1")?.textContent).toBe(button.textContent);
    expect(container.querySelector("main [role='status']")?.textContent).toContain(
      state().disabledReason,
    );
  }
  await receive("setup.state", state());
  expect(container.querySelector("main h1")?.textContent).toBe("Security");
  await receive("setup.state", { ...state(), watchReady: true, disabledReason: null });
  expect(container.textContent).not.toContain("Watch unavailable");
});

it("keeps Today as the first route when Watch is ready", async () => {
  await receive("setup.state", { ...state(), watchReady: true, disabledReason: null });
  await render(<Shell />);
  expect(container.querySelector("main h1")?.textContent).toBe("Today");
});
