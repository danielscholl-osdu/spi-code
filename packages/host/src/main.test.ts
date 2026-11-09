// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Message, PROTOCOL_VERSION } from "@spi-code/contracts";
import { expect, it, vi } from "vitest";
import type { HostConnection } from "./process/connections.js";
import type { ConversationBackend } from "./process/conversation.js";
import type { SetupService, SetupServiceOptions } from "./setup/service.js";
import type { SweepServiceOptions } from "./sweep/service.js";
import { emptySweepStatus } from "./sweep/status.js";

const mocks = vi.hoisted(() => ({
  createBackend: vi.fn(),
  close: vi.fn(),
  realSetup: false,
  capturedPath: "/usr/bin:/bin",
  setupConnect: vi.fn(),
  setupRoute: vi.fn(),
  setupOptions: [] as SetupServiceOptions[],
  setupServices: [] as SetupService[],
  probeSeat: vi.fn().mockResolvedValue({ kind: "seat-ok", models: ["auto"] }),
}));
vi.mock("./store/store.js", () => ({ openRunStore: () => ({ close: mocks.close }) }));
// The stub records what main.ts wires; the real-wiring test swaps in the real SetupService.
vi.mock("./setup/service.js", async (original) => {
  const actual = await original<typeof import("./setup/service.js")>();
  return {
    ...actual,
    SetupService: function SetupService(options: SetupServiceOptions) {
      mocks.setupOptions.push(options);
      if (mocks.realSetup) {
        const service = new actual.SetupService(options);
        mocks.setupServices.push(service);
        return service;
      }
      return {
        routes: { "setup.install": mocks.setupRoute },
        connect: mocks.setupConnect,
        doctor: () => ({ state: "clear", problems: [] }),
        stop: async () => {},
      };
    },
  };
});
vi.mock("./setup/seat.js", () => ({
  probeCopilotSeat: mocks.probeSeat,
}));
vi.mock("./env/shell-environment.js", async (original) => ({
  ...(await original<typeof import("./env/shell-environment.js")>()),
  captureLoginShellPath: async () => ({ path: mocks.capturedPath, captured: true, failures: [] }),
}));
vi.mock("@spi-code/tools", async (original) => {
  const actual = await original<typeof import("@spi-code/tools")>();
  return {
    ...actual,
    createToolInstaller: (appData: string) =>
      actual.createToolInstaller(
        appData,
        process.platform === "win32" ? "win32-x64" : "darwin-arm64",
      ),
  };
});
vi.mock("./process/conversation.js", async (original) => ({
  ...(await original<typeof import("./process/conversation.js")>()),
  createConversationBackend: mocks.createBackend,
}));

it("serializes backend startup and in-flight turns across reloads with correct event ids", async () => {
  let connect: (event: HostConnection) => void = () => {};
  const parentPort = {
    on: (_event: string, listener: typeof connect) => {
      connect = listener;
    },
  };
  const originalParent = Object.getOwnPropertyDescriptor(process, "parentPort");
  const originalArgs = process.argv;
  const once = vi.spyOn(process, "once").mockReturnValue(process);
  Object.defineProperty(process, "parentPort", { value: parentPort, configurable: true });
  process.argv = [originalArgs[0] ?? "node", "host", "/tmp/unused.sqlite"];
  const deferred = <T>() => {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const startup = deferred<ConversationBackend>();
  const blocked = deferred<void>();
  const started = deferred<void>();
  let observe: (event: { callId: string; name: string; outcome: "completed" }) => void = () => {};
  let active = 0;
  let peak = 0;
  const order: string[] = [];
  const backend: ConversationBackend = {
    mode: "stub",
    generation: 1,
    models: async () => [{ id: "stub", name: "Stub" }],
    endSession() {},
    stop: async () => {},
    async turn(_model, prompt, delta) {
      active++;
      peak = Math.max(peak, active);
      order.push(prompt);
      if (prompt === "first") {
        started.resolve();
        await blocked.promise;
      }
      observe({ callId: prompt, name: "spi_brief", outcome: "completed" });
      delta(prompt);
      active--;
    },
  };
  mocks.createBackend.mockImplementation((_path, _stub, listener) => {
    observe = listener;
    return startup.promise;
  });
  const sent: Message[] = [];
  const port = () => {
    let receive: (event: { data: unknown }) => void = () => {};
    return {
      on(_event: string, listener: typeof receive) {
        receive = listener;
      },
      postMessage(message: Message) {
        sent.push(message);
      },
      start() {},
      close() {},
      send(id: string, type: string, payload: unknown) {
        receive({ data: { version: PROTOCOL_VERSION, id, kind: "request", type, payload } });
      },
      request(id: string) {
        receive({
          data: {
            version: PROTOCOL_VERSION,
            id,
            kind: "request",
            type: "turn.start",
            payload: { modelId: "stub", prompt: id },
          },
        });
      },
    };
  };
  const ping = {
    version: PROTOCOL_VERSION,
    id: "connect",
    kind: "request",
    type: "ping",
    payload: {},
  };
  try {
    await import("./main.js");
    const first = port();
    connect({ data: ping, ports: [first] });
    first.request("first");
    await vi.waitFor(() => expect(mocks.createBackend).toHaveBeenCalledOnce());
    const duringStartup = port();
    connect({ data: ping, ports: [duringStartup] });
    duringStartup.request("second");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mocks.createBackend).toHaveBeenCalledOnce();
    startup.resolve(backend);
    await started.promise;
    const duringTurn = port();
    connect({ data: ping, ports: [duringTurn] });
    duringTurn.request("third");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(["first"]);
    blocked.resolve();
    await vi.waitFor(() => expect(sent.filter(({ type }) => type === "turn.end")).toHaveLength(3));
    expect(peak).toBe(1);
    expect(order).toEqual(["first", "second", "third"]);
    expect(sent.filter(({ type }) => type === "tool.call").map(({ id }) => id)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(mocks.createBackend).toHaveBeenCalledOnce();
    const setupOptions = mocks.setupOptions.at(-1);
    expect(setupOptions).toBeDefined();
    await setupOptions?.probeSeat();
    const probeOptions = mocks.probeSeat.mock.calls.at(-1)?.[0];
    expect(probeOptions).toMatchObject({
      installer: { binDir: expect.any(Function) },
    });
    expect(probeOptions).not.toHaveProperty("readToken");
    expect(mocks.createBackend.mock.calls[0]?.[3]).toBe(probeOptions.installer);

    expect(mocks.setupConnect).toHaveBeenCalledTimes(3);
    const toWindow = mocks.setupConnect.mock.calls.at(-1)?.[0] as (message: Message) => void;
    toWindow({
      version: PROTOCOL_VERSION,
      id: "setup-probe",
      kind: "event",
      type: "tool.call",
      payload: { callId: "setup", name: "setup", outcome: "completed", arguments: {} },
    });
    expect(sent.at(-1)?.id).toBe("setup-probe");
    duringTurn.send("install", "setup.install", { tool: "gh" });
    await vi.waitFor(() =>
      expect(mocks.setupRoute).toHaveBeenCalledWith(
        expect.objectContaining({ id: "install", type: "setup.install" }),
        expect.any(Function),
      ),
    );
  } finally {
    blocked.resolve();
    startup.resolve(backend);
    process.argv = originalArgs;
    if (originalParent) Object.defineProperty(process, "parentPort", originalParent);
    else Reflect.deleteProperty(process, "parentPort");
    once.mockRestore();
  }
});

const GH_FIXTURE = `#!/bin/sh
here="$(cd "$(dirname "$0")" && pwd)"
mark="$here/../../signed-in"
case "$1 $2" in
  "auth status")
    if [ -f "$mark" ]; then
      printf 'github.com\\n  Logged in to github.com account fixture (keyring)\\n  - Active account: true\\n  - Token: gho_****\\n  - Token scopes: '"'"'repo'"'"', '"'"'workflow'"'"'\\n' >&2
      exit 0
    fi
    printf 'You are not logged into any GitHub hosts.\\n' >&2
    exit 1;;
  "auth token")
    [ -f "$mark" ] && echo gho_fixture && exit 0
    exit 1;;
  "api rate_limit")
    echo check >> "$here/../../budget-checks"
    if [ -f "$here/../../budget-failed" ]; then
      printf '{"errors":[{"message":"budget unavailable"}]}'
    elif [ -f "$here/../../budget-exhausted" ]; then
      printf '{"resources":{"graphql":{"remaining":0,"reset":${Date.parse("2026-11-08T16:05:00Z") / 1000}}}}'
    else
      printf '{"resources":{"graphql":{"remaining":1234,"reset":${Date.parse("2026-11-08T16:00:00Z") / 1000}}}}'
    fi
    exit 0;;
  "--version ")
    echo "gh version 2.74.0 (2025-06-01)"
    exit 0;;
esac
echo "spi-fixture-gh $*"
`;

it("keeps explicit smoke Setup fixture-only and forbids every external command", async () => {
  vi.resetModules();
  mocks.setupConnect.mockClear();
  const originalParent = Object.getOwnPropertyDescriptor(process, "parentPort");
  const originalArgs = process.argv;
  const once = vi.spyOn(process, "once").mockReturnValue(process);
  let connect: (event: HostConnection) => void = () => {};
  Object.defineProperty(process, "parentPort", {
    value: { on: (_event: string, listener: typeof connect) => (connect = listener) },
    configurable: true,
  });
  process.argv = [
    originalArgs[0] ?? "node",
    "host",
    "/tmp/unused.sqlite",
    "--stub-model",
    "--smoke",
  ];
  try {
    await import("./main.js");
    const sent: Message[] = [];
    connect({
      data: {
        version: PROTOCOL_VERSION,
        id: "connect",
        kind: "request",
        type: "ping",
        payload: {},
      },
      ports: [
        {
          on() {},
          postMessage: (message: Message) => sent.push(message),
          start() {},
          close() {},
        },
      ],
    });
    expect(mocks.setupConnect).not.toHaveBeenCalled();
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "setup.state",
        payload: {
          tools: [],
          watchReady: true,
          disabledReason: null,
          checkedAt: expect.any(String),
        },
      }),
    );
    const options = mocks.setupOptions.at(-1);
    expect(options).toBeDefined();
    await expect(options?.exec.runText("gh", ["auth", "token"])).rejects.toThrow("forbidden");
    await expect(options?.exec.runJSON("glab", ["api", "fixture"])).rejects.toThrow("forbidden");
  } finally {
    process.argv = originalArgs;
    if (originalParent) Object.defineProperty(process, "parentPort", originalParent);
    else Reflect.deleteProperty(process, "parentPort");
    once.mockRestore();
  }
});

it.skipIf(process.platform === "win32")(
  "checks an exhausted budget without blocking ordinary refreshes, and maintains the Watch gate",
  async () => {
    const actualStore =
      await vi.importActual<typeof import("./store/store.js")>("./store/store.js");
    const directory = mkdtempSync(join(tmpdir(), "spi-main-"));
    const storePath = join(directory, "app", "spi.sqlite");
    mkdirSync(join(directory, "app"));
    actualStore.openRunStore(storePath).close();
    const shell = join(directory, "shell", "bin");
    mkdirSync(shell, { recursive: true });
    writeFileSync(join(shell, "gh"), GH_FIXTURE);
    chmodSync(join(shell, "gh"), 0o755);
    writeFileSync(join(directory, "signed-in"), "");
    mocks.capturedPath = `${shell}:/usr/bin:/bin`;
    mocks.realSetup = true;
    vi.resetModules();
    const { SweepService } = await import("./sweep/service.js");
    const { WatchRoutes } = await import("./process/routes.js");
    const deferredAreas = [{ area: "security", reason: "insufficient budget" }];
    const status = vi.spyOn(WatchRoutes.prototype, "status", "get").mockReturnValue({
      ...emptySweepStatus(),
      remaining: 10,
      resetAt: null,
      floor: 125,
      deferredAreas,
    });
    const start = vi.spyOn(SweepService.prototype, "start").mockResolvedValue(true);
    const stop = vi.spyOn(SweepService.prototype, "stop").mockResolvedValue();
    let connect: (event: HostConnection) => void = () => {};
    const originalParent = Object.getOwnPropertyDescriptor(process, "parentPort");
    const originalArgs = process.argv;
    const once = vi.spyOn(process, "once").mockReturnValue(process);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    Object.defineProperty(process, "parentPort", {
      value: { on: (_event: string, listener: typeof connect) => (connect = listener) },
      configurable: true,
    });
    process.argv = [originalArgs[0] ?? "node", "host", storePath];
    const port = () => {
      const sent: Message[] = [];
      let receive: (event: { data: unknown }) => void = () => {};
      return {
        sent,
        on(_event: string, listener: typeof receive) {
          receive = listener;
        },
        postMessage: (message: Message) => sent.push(message),
        start() {},
        close() {},
        check(id: string) {
          receive({
            data: {
              version: PROTOCOL_VERSION,
              id,
              kind: "request",
              type: "setup.check",
              payload: {},
            },
          });
        },
      };
    };
    const ping = {
      version: PROTOCOL_VERSION,
      id: "connect",
      kind: "request",
      type: "ping",
      payload: {},
    };
    const setupStates = (sent: Message[]) =>
      sent.flatMap((message) => (message.type === "setup.state" ? [message.payload] : []));
    try {
      await import("./main.js");
      const first = port();
      connect({ data: ping, ports: [first] });
      await vi.waitFor(() => expect(setupStates(first.sent).at(-1)?.watchReady).toBe(true), {
        timeout: 10_000,
      });
      const gh = setupStates(first.sent)
        .at(-1)
        ?.tools.find((row) => row.tool === "gh");
      expect(gh?.reason).toContain("Using gh 2.74.0 from the login-shell PATH.");
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
      expect(stop).not.toHaveBeenCalled();
      const wired = (start.mock.contexts[0] as unknown as { options: SweepServiceOptions }).options;
      const publishStatus = vi
        .spyOn(WatchRoutes.prototype, "publishStatus")
        .mockImplementation(() => {});
      wired.onStatus?.({ nextSweepAt: "2026-11-08T15:10:00.000Z", forceCooldownUntil: null });
      expect(publishStatus).toHaveBeenCalledExactlyOnceWith({
        nextSweepAt: "2026-11-08T15:10:00.000Z",
        forceCooldownUntil: null,
      });
      publishStatus.mockRestore();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-08T15:05:00Z"));
      mocks.probeSeat.mockClear();
      first.check("check-one");
      first.check("check-two");
      await vi.waitFor(() => expect(setupStates(first.sent)).toHaveLength(4), {
        timeout: 10_000,
      });
      await vi.waitFor(
        () => expect(first.sent.filter(({ type }) => type === "sweep.status")).toHaveLength(1),
        {
          timeout: 10_000,
        },
      );
      expect(mocks.probeSeat).toHaveBeenCalledOnce();
      for (const id of ["check-one", "check-two"])
        expect(first.sent).toContainEqual(expect.objectContaining({ id, type: "setup.state" }));
      expect(setupStates(first.sent).at(-1)?.checkedAt).toBeDefined();
      expect(setupStates(first.sent).at(-1)?.checkedAt).toMatch(/^2026-11-08T15:05:/);
      expect(first.sent).toContainEqual(
        expect.objectContaining({
          type: "sweep.status",
          payload: {
            ...emptySweepStatus(),
            remaining: 1234,
            resetAt: "2026-11-08T16:00:00.000Z",
            floor: 125,
            deferredAreas,
          },
        }),
      );
      expect(readFileSync(join(directory, "budget-checks"), "utf8")).toBe("check\n");
      const service = mocks.setupServices.at(-1);
      const budget = wired.budget;
      if (!service || !budget) throw new Error("Setup service and sweep budget missing.");
      vi.setSystemTime(new Date("2026-11-08T15:05:00Z"));
      await budget.run(1, async () => ({
        value: undefined,
        rate: { cost: 1, remaining: 0, resetAt: "2026-11-08T16:05:00Z" },
      }));
      budget.hold(90_000, "fixture throttle");
      writeFileSync(join(directory, "budget-exhausted"), "");
      let checked = false;
      const check = Promise.resolve(
        service.routes["setup.check"]?.(
          {
            version: PROTOCOL_VERSION,
            id: "exhausted",
            kind: "request",
            type: "setup.check",
            payload: {},
          },
          () => {},
        ),
      ).then(() => {
        checked = true;
      });
      await vi.waitFor(() => expect(checked).toBe(true), { timeout: 5000 });
      await check;
      expect(setupStates(first.sent)).toHaveLength(5);
      expect(first.sent.filter(({ type }) => type === "sweep.status").at(-1)).toMatchObject({
        payload: { remaining: 0, resetAt: "2026-11-08T16:05:00.000Z", floor: 125, deferredAreas },
      });
      let refreshed = false;
      const refresh = service.refresh().then(() => {
        refreshed = true;
      });
      await vi.waitFor(() => expect(refreshed).toBe(true), { timeout: 5000 });
      await refresh;
      expect(readFileSync(join(directory, "budget-checks"), "utf8")).toBe("check\ncheck\n");

      writeFileSync(join(directory, "budget-failed"), "");
      const setupOptions = mocks.setupOptions.at(-1);
      if (!setupOptions) throw new Error("Setup options missing.");
      const error = vi.spyOn(setupOptions, "onError").mockImplementation(() => {});
      try {
        first.check("check-failed");
        await vi.waitFor(
          () => expect(first.sent.filter(({ type }) => type === "sweep.status")).toHaveLength(3),
          {
            timeout: 10_000,
          },
        );
        expect(first.sent.filter(({ type }) => type === "sweep.status").at(-1)).toMatchObject({
          payload: {
            remaining: null,
            resetAt: null,
            floor: 125,
            deferredAreas,
          },
        });
        expect(error).toHaveBeenCalledWith(
          expect.objectContaining({ message: "The GitHub API budget check did not complete." }),
        );
      } finally {
        error.mockRestore();
      }
      const core = await import("@spi-code/core");
      const replay = new core.Sweeper({
        ctx: wired.ctx,
        exec: wired.exec,
        factsSchema: wired.factsSchema,
        cacheSchema: core.cacheSchema,
        emptyCache: core.emptyCache,
        areas: [],
        persist: { load: async () => undefined, save: async () => {} },
        replay: async () => ({
          facts: { ...core.emptyFacts(), auth: { data: { gh: { ok: "yes" }, glab: {} } } },
          cache: core.emptyCache(),
          reads: {},
        }),
      });
      await expect(replay.sweep()).rejects.toMatchObject({
        issues: expect.arrayContaining([
          expect.objectContaining({ path: ["facts", "auth", "data", "gh", "ok"] }),
        ]),
      });
      expect(replay.facts).toEqual(core.emptyFacts());

      rmSync(join(directory, "signed-in"));
      const second = port();
      connect({ data: ping, ports: [second] });
      await vi.waitFor(() => expect(setupStates(second.sent).at(-1)?.watchReady).toBe(false), {
        timeout: 10_000,
      });
      await vi.waitFor(() => expect(stop).toHaveBeenCalled());
    } finally {
      vi.useRealTimers();
      const handler = (event: string) =>
        once.mock.calls.find(([name]) => name === event)?.[1] as (() => void) | undefined;
      handler("SIGTERM")?.();
      await vi.waitFor(() => expect(exit).toHaveBeenCalled());
      handler("exit")?.();
      mocks.realSetup = false;
      process.argv = originalArgs;
      if (originalParent) Object.defineProperty(process, "parentPort", originalParent);
      else Reflect.deleteProperty(process, "parentPort");
      once.mockRestore();
      exit.mockRestore();
      start.mockRestore();
      stop.mockRestore();
      status.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
