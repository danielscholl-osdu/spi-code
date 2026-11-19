// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Message, PROTOCOL_VERSION, parseMessage } from "@spi-code/contracts";
import { expect, it, vi } from "vitest";
import { APPENDIX_A_TOOLS } from "../tools/tool-names.js";
import {
  type ConversationBackend,
  conversationHandler,
  createConversationBackend,
} from "./conversation.js";

const list: Message = {
  version: PROTOCOL_VERSION,
  id: "list",
  kind: "request",
  type: "models.list",
  payload: {},
};
const turn: Message = {
  version: PROTOCOL_VERSION,
  id: "turn",
  kind: "request",
  type: "turn.start",
  payload: { modelId: "stub", prompt: "Exercise the tools" },
};

it("runs every appendix A tool through the real gates and refuses the built-in", async () => {
  const observations: { name: string; outcome: string }[] = [];
  const backend = await createConversationBackend("/tmp/unused", true, (event) =>
    observations.push(event),
  );
  const messages: Message[] = [];
  await conversationHandler(backend, (message) => messages.push(message))(turn);
  expect(observations).toEqual([
    ...APPENDIX_A_TOOLS.map(({ name, tier }) => ({
      name,
      outcome: tier === "Read" ? "completed" : "refused",
      callId: expect.any(String),
    })),
    { name: "builtin:shell", outcome: "refused", callId: expect.any(String) },
  ]);
  expect(messages.map((message) => parseMessage(message).ok)).not.toContain(false);
  expect(messages).toMatchObject([
    { type: "signin.state", payload: { signedIn: false, mode: "stub" } },
    { type: "models.result" },
    { type: "turn.delta" },
    { type: "turn.end", payload: { reason: "completed" } },
  ]);
});

function fakeBackend(): ConversationBackend {
  return {
    mode: "gh",
    generation: 1,
    models: vi.fn(async () => ({ models: [{ id: "stub", name: "Stub" }] })),
    turn: vi.fn(async (_model, _prompt, delta) => {
      delta("OK");
    }),
    endSession: vi.fn(),
    stop: vi.fn(async () => {}),
  };
}

it("announces account-switch session endings before publishing the replacement catalog", async () => {
  const backend = fakeBackend();
  const messages: Message[] = [];
  const handle = conversationHandler(backend, (message) => messages.push(message));
  await handle(turn);
  Object.defineProperty(backend, "generation", { value: 2 });
  messages.length = 0;
  await handle(list);
  expect(backend.endSession).toHaveBeenCalledOnce();
  expect(messages).toMatchObject([
    { type: "session.ended", payload: { reason: "credential_changed" } },
    { type: "signin.state", payload: { signedIn: true } },
    { type: "models.result" },
  ]);
});

it("never forwards credential-bearing errors and terminates a failed turn explicitly", async () => {
  const backend = fakeBackend();
  const secret = "credential-that-must-not-cross-the-port";
  backend.models = vi.fn(async () => {
    throw new Error(secret);
  });
  const messages: Message[] = [];
  await conversationHandler(backend, (message) => messages.push(message))(turn);
  expect(JSON.stringify(messages)).not.toContain(secret);
  expect(messages).toMatchObject([
    { type: "signin.state", payload: { signedIn: false } },
    { type: "session.ended" },
    { type: "error", payload: { code: "copilot_failed" } },
    { type: "turn.end", payload: { reason: "error" } },
  ]);
  expect(backend.turn).not.toHaveBeenCalled();
});

it("does not dispatch a model absent from the current catalog", async () => {
  const backend = fakeBackend();
  backend.models = vi.fn(async () => ({ models: [] }));
  const send = vi.fn();
  await conversationHandler(backend, send)(turn);
  expect(backend.turn).not.toHaveBeenCalled();
  expect(backend.stop).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "error",
      payload: {
        code: "copilot_failed",
        message: "The selected model is no longer available. Refresh models and retry.",
      },
    }),
  );
  expect(send).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "turn.end", payload: { reason: "error" } }),
  );
});

it("does not claim a turn failure means gh is signed out", async () => {
  const backend = fakeBackend();
  backend.turn = vi.fn(async () => {
    throw new Error("runtime failure");
  });
  const messages: Message[] = [];
  await conversationHandler(backend, (message) => messages.push(message))(turn);
  expect(messages.filter((message) => message.type === "signin.state")).toEqual([
    {
      version: PROTOCOL_VERSION,
      id: "turn",
      kind: "event",
      type: "signin.state",
      payload: { signedIn: true, mode: "gh" },
    },
  ]);
  expect(backend.stop).not.toHaveBeenCalled();
  expect(messages.find((message) => message.type === "error")).toMatchObject({
    payload: { message: "Copilot turn failed. Retry the turn." },
  });
  expect(messages.at(-1)).toMatchObject({ type: "turn.end", payload: { reason: "error" } });
});

it.each(["signin.state", "session.ended", "tool.call"])("rejects token fields on %s", (type) => {
  const payload =
    type === "signin.state"
      ? { signedIn: true, mode: "gh" }
      : type === "session.ended"
        ? { reason: "credential_changed" }
        : { name: "spi_brief", callId: "call", arguments: {}, outcome: "completed" };
  expect(
    parseMessage({
      version: PROTOCOL_VERSION,
      id: "x",
      kind: "event",
      type,
      payload: { ...payload, token: "secret" },
    }).ok,
  ).toBe(false);
});

it("does not announce a stale session ending after generation changes inside a turn", async () => {
  const backend = fakeBackend();
  backend.turn = vi.fn(async () => {
    Object.defineProperty(backend, "generation", { value: 2 });
  });
  const messages: Message[] = [];
  const handle = conversationHandler(backend, (message) => messages.push(message));
  await handle(turn);
  messages.length = 0;
  await handle(list);
  expect(messages.some((message) => message.type === "session.ended")).toBe(false);
  expect(backend.endSession).not.toHaveBeenCalled();
});

it("rejects a stub state that claims gh authentication", () => {
  expect(
    parseMessage({
      version: PROTOCOL_VERSION,
      id: "stub",
      kind: "event",
      type: "signin.state",
      payload: { mode: "stub", signedIn: true },
    }).ok,
  ).toBe(false);
});

it("returns the recorded Copilot picker fields over the model list contract", async () => {
  const { projectCatalog } = await import("../threads/catalog.js");
  const backend = fakeBackend();
  const capabilities = {
    supports: { reasoningEffort: true },
    limits: { max_context_window_tokens: 1000 },
  };
  backend.models = async () =>
    projectCatalog({
      catalog: {
        models: [
          {
            id: "reasoning",
            name: "Reasoning",
            capabilities,
            billing: { multiplier: 2 },
            supportedReasoningEfforts: ["low", "high"],
            defaultReasoningEffort: "high",
            policy: { state: "disabled", terms: "Enable this model in GitHub settings." },
          },
          {
            id: "reported",
            name: "Reported",
            capabilities: { ...capabilities, supports: { reasoningEffort: false } },
            billing: { multiplier: -1 },
            supportedReasoningEfforts: [""],
            defaultReasoningEffort: "medium",
            policy: { state: "unrecognized" as "enabled", terms: "Reported terms." },
          },
        ],
      },
      login: "recorded-account",
      premium: {
        isUnlimitedEntitlement: false,
        entitlementRequests: 300,
        usedRequests: -1,
        resetDate: "invalid date",
        usageAllowedWithExhaustedQuota: false,
        remainingPercentage: 86,
        overage: 0,
        overageAllowedWithExhaustedQuota: false,
      },
    });
  const messages: Message[] = [];
  await conversationHandler(backend, (message) => messages.push(message))(list);
  const picker = messages.find((message) => message.type === "models.result");
  expect(parseMessage(picker)).toEqual({
    ok: true,
    message: {
      version: PROTOCOL_VERSION,
      id: "list",
      kind: "response",
      type: "models.result",
      payload: {
        models: [
          {
            id: "reasoning",
            name: "Reasoning",
            multiplier: 2,
            reasoning: { supported: true, levels: ["low", "high"], defaultLevel: "high" },
            policy: { state: "disabled", reason: "Enable this model in GitHub settings." },
          },
          {
            id: "reported",
            name: "Reported",
            multiplier: "not known",
            reasoning: { supported: false, levels: "not known", defaultLevel: "medium" },
            policy: { state: "not known", reason: "Reported terms." },
          },
        ],
        account: { login: "recorded-account" },
        usage: { used: "not known", entitlement: 300, resetAt: "not known" },
      },
    },
  });
});
