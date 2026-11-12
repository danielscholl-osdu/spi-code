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
vi.mock("./store/open.js", async (original) => {
  const actual = await original<typeof import("./store/open.js")>();
  return {
    openStore: (path: string) =>
      path === "/tmp/unused.sqlite" ? { close: mocks.close } : actual.openStore(path),
  };
});
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
    const { startHost } = await import("./host.js");
    startHost({
      storePath: process.argv[2] ?? "",
      stub: process.argv.includes("--stub-model"),
      smoke: process.argv.includes("--smoke"),
      parentPort: (
        process as typeof process & {
          parentPort: { on(event: "message", listener: (event: HostConnection) => void): void };
        }
      ).parentPort,
      env: process.env,
      platform: process.platform,
      pid: process.pid,
      lifecycle: process,
    });
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
here="\${0%/*}"
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
    const { startHost } = await import("./host.js");
    startHost({
      storePath: process.argv[2] ?? "",
      stub: process.argv.includes("--stub-model"),
      smoke: process.argv.includes("--smoke"),
      parentPort: (
        process as typeof process & {
          parentPort: { on(event: "message", listener: (event: HostConnection) => void): void };
        }
      ).parentPort,
      env: process.env,
      platform: process.platform,
      pid: process.pid,
      lifecycle: process,
    });
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
    const wait = { timeout: 15_000, interval: 10 };
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
      const completions = new Map<string, () => void>();
      let receive: (event: { data: unknown }) => void = () => {};
      return {
        sent,
        on(_event: string, listener: typeof receive) {
          receive = listener;
        },
        postMessage(message: Message) {
          sent.push(message);
          if (message.type === "setup.state") {
            completions.get(message.id)?.();
            completions.delete(message.id);
          }
        },
        start() {},
        close() {},
        check(id: string) {
          return new Promise<void>((resolve) => {
            completions.set(id, resolve);
            receive({
              data: {
                version: PROTOCOL_VERSION,
                id,
                kind: "request",
                type: "setup.check",
                payload: {},
              },
            });
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
      const { startHost } = await import("./host.js");
      startHost({
        storePath: process.argv[2] ?? "",
        stub: process.argv.includes("--stub-model"),
        smoke: process.argv.includes("--smoke"),
        parentPort: (
          process as typeof process & {
            parentPort: { on(event: "message", listener: (event: HostConnection) => void): void };
          }
        ).parentPort,
        env: process.env,
        platform: process.platform,
        pid: process.pid,
        lifecycle: process,
      });
      const first = port();
      connect({ data: ping, ports: [first] });
      await vi.waitFor(() => expect(setupStates(first.sent).at(-1)?.watchReady).toBe(true), wait);
      const gh = setupStates(first.sent)
        .at(-1)
        ?.tools.find((row) => row.tool === "gh");
      expect(gh?.reason).toContain("Using gh 2.74.0 from the login-shell PATH.");
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce(), wait);
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
      const checks = Promise.all([first.check("check-one"), first.check("check-two")]);
      await vi.waitFor(() => checks, wait);
      expect(setupStates(first.sent)).toHaveLength(4);
      expect(first.sent.filter(({ type }) => type === "sweep.status")).toHaveLength(1);
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
      );
      await vi.waitFor(() => check, wait);
      expect(setupStates(first.sent)).toHaveLength(5);
      expect(first.sent.filter(({ type }) => type === "sweep.status").at(-1)).toMatchObject({
        payload: { remaining: 0, resetAt: "2026-11-08T16:05:00.000Z", floor: 125, deferredAreas },
      });
      const refresh = service.refresh();
      await vi.waitFor(() => refresh, wait);
      expect(service.current?.watchReady).toBe(true);
      expect(start).toHaveBeenCalledOnce();
      expect(stop).not.toHaveBeenCalled();
      expect(readFileSync(join(directory, "budget-checks"), "utf8")).toBe("check\ncheck\n");

      writeFileSync(join(directory, "budget-failed"), "");
      const setupOptions = mocks.setupOptions.at(-1);
      if (!setupOptions) throw new Error("Setup options missing.");
      const error = vi.spyOn(setupOptions, "onError").mockImplementation(() => {});
      try {
        const failed = first.check("check-failed");
        await vi.waitFor(() => failed, wait);
        expect(first.sent.filter(({ type }) => type === "sweep.status")).toHaveLength(3);
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
      await vi.waitFor(() => expect(setupStates(second.sent).at(-1)?.watchReady).toBe(false), wait);
      await vi.waitFor(() => expect(stop).toHaveBeenCalled(), wait);
    } finally {
      vi.useRealTimers();
      const handler = (event: string) =>
        once.mock.calls.find(([name]) => name === event)?.[1] as (() => void) | undefined;
      handler("SIGTERM")?.();
      await vi.waitFor(() => expect(exit).toHaveBeenCalled(), wait);
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
  60_000,
);

async function composedHost() {
  vi.resetModules();
  mocks.createBackend.mockReset();
  const { startHost } = await import("./host.js");
  let connect: (event: HostConnection) => void = () => {};
  const lifecycle = {
    once: vi.fn().mockReturnThis(),
    exit: vi.fn() as unknown as NodeJS.Process["exit"],
  };
  mocks.realSetup = true;
  let host: ReturnType<typeof startHost>;
  try {
    host = startHost({
      storePath: "/tmp/unused.sqlite",
      stub: true,
      smoke: true,
      parentPort: {
        on(_event, listener) {
          connect = listener;
        },
      },
      env: {},
      platform: process.platform,
      pid: 123,
      lifecycle,
    });
  } finally {
    mocks.realSetup = false;
  }
  const setup = mocks.setupServices.at(-1);
  if (!setup) throw new Error("Setup service missing");
  const setupStop = vi.spyOn(setup, "stop");
  const sent: Message[] = [];
  let receive: (event: { data: unknown }) => void = () => {};
  const port = {
    on(_event: "message", listener: typeof receive) {
      receive = listener;
    },
    postMessage(message: Message) {
      sent.push(message);
    },
    start() {},
    close: vi.fn(),
  };
  const attach = () =>
    connect({
      data: {
        version: PROTOCOL_VERSION,
        id: "connect",
        kind: "request",
        type: "ping",
        payload: {},
      },
      ports: [port],
    });
  const request = (id: string, type = "models.list") =>
    receive({
      data: {
        version: PROTOCOL_VERSION,
        id,
        kind: "request",
        type,
        payload: type === "turn.start" ? { modelId: "stub", prompt: id } : {},
      },
    });
  return { ...host, sent, attach, request, lifecycle, port, setupStop };
}

it("the composed turn registration holds models.list on the shared queue", async () => {
  const host = await composedHost();
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const models = vi.fn(async () => [{ id: "stub", name: "Stub" }]);
  const turn = vi.fn(async () => {
    await blocked;
  });
  mocks.createBackend.mockResolvedValue({
    mode: "stub",
    generation: 1,
    models,
    turn,
    endSession() {},
    stop: async () => {},
  });
  host.attach();
  try {
    host.request("turn", "turn.start");
    await vi.waitFor(() => expect(turn).toHaveBeenCalledOnce());
    host.request("list");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(models).toHaveBeenCalledOnce();
    expect(host.sent).not.toContainEqual(expect.objectContaining({ id: "list" }));
    release();
    await vi.waitFor(() =>
      expect(host.sent).toContainEqual(
        expect.objectContaining({ id: "list", type: "models.result" }),
      ),
    );
    expect(models).toHaveBeenCalledTimes(2);
  } finally {
    release();
    await host.stop();
  }
});

it("cannot route before attachment or after stop, including queued requests and late connections", async () => {
  const host = await composedHost();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const request: Message = {
    version: PROTOCOL_VERSION,
    id: "early",
    kind: "request",
    type: "models.list",
    payload: {},
  };
  try {
    const { attachHostPort } = await import("./process/port.js");
    let receive: (event: { data: unknown }) => void = () => {};
    const early: Message[] = [];
    const stopEarly = attachHostPort(
      {
        on(_event, listener) {
          receive = listener;
        },
        postMessage(message) {
          early.push(message as Message);
        },
        start() {},
      },
      123,
      host.routes,
    );
    receive({ data: request });
    await vi.waitFor(() =>
      expect(early).toContainEqual(
        expect.objectContaining({
          id: "early",
          type: "error",
          payload: { code: "host_failed", message: "Host request failed" },
        }),
      ),
    );
    stopEarly();
    expect(mocks.createBackend).not.toHaveBeenCalled();
    host.attach();
    host.request("queued");
    await host.stop();
    host.request("late");
    for (const id of ["queued", "late"])
      expect(host.sent).toContainEqual(
        expect.objectContaining({
          id,
          type: "error",
          payload: { code: "host_failed", message: "Host request failed" },
        }),
      );
    expect(() => host.routes["models.list"]?.(request, () => {})).toThrow("stopped");
    host.attach();
    expect(log).toHaveBeenCalledWith("Rejected host connection after stop");
    expect(host.port.close).toHaveBeenCalled();
    expect(mocks.createBackend).not.toHaveBeenCalled();
  } finally {
    await host.stop();
    log.mockRestore();
  }
});

it("SIGTERM stops setup before the backend and closes the store once", async () => {
  const host = await composedHost();
  const order: string[] = [];
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  host.setupStop.mockImplementation(async () => {
    order.push("setup");
    await blocked;
  });
  const backendStop = vi.fn(async () => {
    order.push("backend");
  });
  mocks.createBackend.mockResolvedValue({
    mode: "stub",
    generation: 1,
    models: async () => [{ id: "stub", name: "Stub" }],
    turn: async () => {},
    endSession() {},
    stop: backendStop,
  });
  host.attach();
  host.request("list");
  await vi.waitFor(() =>
    expect(host.sent).toContainEqual(
      expect.objectContaining({ id: "list", type: "models.result" }),
    ),
  );
  mocks.close.mockClear();
  const signal = host.lifecycle.once.mock.calls.find(
    ([event]) => event === "SIGTERM",
  )?.[1] as () => void;
  try {
    signal();
    expect(order).toEqual(["setup"]);
    expect(backendStop).not.toHaveBeenCalled();
    release();
    await host.stop();
    await vi.waitFor(() => expect(host.lifecycle.exit).toHaveBeenCalledWith(0));
    expect(order).toEqual(["setup", "backend"]);
    const exit = host.lifecycle.once.mock.calls.find(
      ([event]) => event === "exit",
    )?.[1] as () => void;
    exit();
    expect(mocks.close).toHaveBeenCalledOnce();
  } finally {
    release();
    await host.stop();
  }
});

it("refuses smoke without a stub before opening the store or attaching a connection", async () => {
  const { startHost } = await import("./host.js");
  const on = vi.fn();
  mocks.close.mockClear();
  expect(() =>
    startHost({
      storePath: "/tmp/unused.sqlite",
      stub: false,
      smoke: true,
      parentPort: { on },
      env: {},
      platform: process.platform,
      pid: 123,
      lifecycle: process,
    }),
  ).toThrow("Smoke requires the stub model");
  expect(on).not.toHaveBeenCalled();
  expect(mocks.close).not.toHaveBeenCalled();
});

it("tags detached tool callbacks with their active turn and logs callbacks with no owner", async () => {
  const host = await composedHost();
  let observe: Parameters<typeof import("./process/conversation.js").createConversationBackend>[2] =
    () => {};
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const turn = vi.fn(async () => {
    await blocked;
  });
  mocks.createBackend.mockImplementation((_path, _stub, listener) => {
    observe = listener;
    return {
      mode: "stub",
      generation: 1,
      models: async () => [{ id: "stub", name: "Stub" }],
      turn,
      endSession() {},
      stop: async () => {},
    };
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    host.attach();
    host.request("owner", "turn.start");
    await vi.waitFor(() => expect(turn).toHaveBeenCalledOnce());
    observe({ callId: "detached", name: "spi_brief", outcome: "completed" });
    expect(host.sent).toContainEqual(
      expect.objectContaining({
        id: "owner",
        type: "tool.call",
        payload: { callId: "detached", name: "spi_brief", outcome: "completed", arguments: {} },
      }),
    );
    release();
    await vi.waitFor(() =>
      expect(host.sent).toContainEqual(expect.objectContaining({ id: "owner", type: "turn.end" })),
    );
    observe({ callId: "late", name: "spi_brief", outcome: "completed" });
    expect(log).toHaveBeenCalledWith("Tool event has no active turn", "spi_brief", "completed");
    expect(host.sent.filter(({ type }) => type === "tool.call")).toHaveLength(1);
    await host.stop();
    observe({ callId: "stopped", name: "spi_brief", outcome: "completed" });
    expect(host.sent.filter(({ type }) => type === "tool.call")).toHaveLength(1);
  } finally {
    release();
    await host.stop();
    log.mockRestore();
  }
});

it("answers a backend startup failure with host_failed and retries the next serial request", async () => {
  const host = await composedHost();
  mocks.createBackend.mockRejectedValueOnce(new Error("private startup detail")).mockResolvedValue({
    mode: "stub",
    generation: 1,
    models: async () => [{ id: "stub", name: "Stub" }],
    turn: async () => {},
    endSession() {},
    stop: async () => {},
  });
  try {
    host.attach();
    host.request("failed");
    host.request("retry");
    await vi.waitFor(() =>
      expect(host.sent).toContainEqual(
        expect.objectContaining({ id: "retry", type: "models.result" }),
      ),
    );
    expect(host.sent).toContainEqual(
      expect.objectContaining({
        id: "failed",
        type: "error",
        payload: { code: "host_failed", message: "Host request failed" },
      }),
    );
    expect(mocks.createBackend).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(host.sent)).not.toContain("private startup detail");
  } finally {
    await host.stop();
  }
});

it("stop waits for an already-started backend and never starts a queued turn", async () => {
  const host = await composedHost();
  let finishStartup: (backend: ConversationBackend) => void = () => {};
  const startup = new Promise<ConversationBackend>((resolve) => {
    finishStartup = resolve;
  });
  const turn = vi.fn();
  const backendStop = vi.fn(async () => {});
  const backend: ConversationBackend = {
    mode: "stub",
    generation: 1,
    models: async () => [{ id: "stub", name: "Stub" }],
    turn,
    endSession() {},
    stop: backendStop,
  };
  mocks.createBackend.mockReturnValue(startup);
  try {
    host.attach();
    host.request("starting");
    await vi.waitFor(() => expect(mocks.createBackend).toHaveBeenCalledOnce());
    host.request("queued-turn", "turn.start");
    const stopped = host.stop();
    expect(backendStop).not.toHaveBeenCalled();
    finishStartup(backend);
    await stopped;
    expect(backendStop).toHaveBeenCalledOnce();
    expect(turn).not.toHaveBeenCalled();
    expect(host.sent).toContainEqual(
      expect.objectContaining({
        id: "queued-turn",
        type: "error",
        payload: { code: "host_failed", message: "Host request failed" },
      }),
    );
  } finally {
    finishStartup(backend);
    await host.stop();
  }
});

it("SIGTERM aborts a live turn before waiting for the request queue", async () => {
  const host = await composedHost();
  let abort = () => {};
  const aborted = new Promise<void>((_resolve, reject) => {
    abort = () => reject(new Error("backend stopped"));
  });
  const turn = vi.fn(() => aborted);
  const backendStop = vi.fn(async () => {
    abort();
  });
  mocks.createBackend.mockResolvedValue({
    mode: "stub",
    generation: 1,
    models: async () => [{ id: "stub", name: "Stub" }],
    turn,
    endSession() {},
    stop: backendStop,
  });
  try {
    host.attach();
    host.request("live-turn", "turn.start");
    await vi.waitFor(() => expect(turn).toHaveBeenCalledOnce());
    const signal = host.lifecycle.once.mock.calls.find(
      ([event]) => event === "SIGTERM",
    )?.[1] as () => void;
    signal();
    await vi.waitFor(() => expect(host.lifecycle.exit).toHaveBeenCalledWith(0));
    expect(backendStop).toHaveBeenCalledOnce();
    expect(host.sent).toContainEqual(
      expect.objectContaining({
        id: "live-turn",
        type: "turn.end",
        payload: { reason: "error" },
      }),
    );
  } finally {
    abort();
    await host.stop();
  }
});

it("stop prevents an in-flight turn startup from calling models or turn", async () => {
  const host = await composedHost();
  let finishStartup: (backend: ConversationBackend) => void = () => {};
  const startup = new Promise<ConversationBackend>((resolve) => {
    finishStartup = resolve;
  });
  const models = vi.fn(async () => [{ id: "stub", name: "Stub" }]);
  const turn = vi.fn(async () => {});
  const backendStop = vi.fn(async () => {});
  const backend: ConversationBackend = {
    mode: "stub",
    generation: 1,
    models,
    turn,
    endSession() {},
    stop: backendStop,
  };
  mocks.createBackend.mockReturnValue(startup);
  try {
    host.attach();
    host.request("starting-turn", "turn.start");
    await vi.waitFor(() => expect(mocks.createBackend).toHaveBeenCalledOnce());
    const stopped = host.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(backendStop).not.toHaveBeenCalled();
    finishStartup(backend);
    await stopped;
    expect(models).not.toHaveBeenCalled();
    expect(turn).not.toHaveBeenCalled();
    expect(backendStop).toHaveBeenCalledOnce();
    expect(host.sent).toContainEqual(
      expect.objectContaining({
        id: "starting-turn",
        type: "error",
        payload: { code: "host_failed", message: "Host request failed" },
      }),
    );
    expect(host.sent).not.toContainEqual(
      expect.objectContaining({ id: "starting-turn", type: "models.result" }),
    );
  } finally {
    finishStartup(backend);
    await host.stop();
  }
});
