// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Message, PROTOCOL_VERSION } from "@spi-code/contracts";
import { expect, it, vi } from "vitest";
import type { HostConnection } from "./process/connections.js";
import type { ConversationBackend } from "./process/conversation.js";

const mocks = vi.hoisted(() => ({ createBackend: vi.fn(), close: vi.fn() }));
vi.mock("./store/store.js", () => ({ openRunStore: () => ({ close: mocks.close }) }));
// Setup reads real tools on connect; this test covers conversation ordering only.
vi.mock("./setup/service.js", () => ({
  SetupService: class {
    routes = {};
    connect(): void {}
    doctor() {
      return { state: "clear", problems: [] };
    }
    async stop(): Promise<void> {}
  },
}));
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
  } finally {
    blocked.resolve();
    startup.resolve(backend);
    process.argv = originalArgs;
    if (originalParent) Object.defineProperty(process, "parentPort", originalParent);
    else Reflect.deleteProperty(process, "parentPort");
    once.mockRestore();
  }
});
