// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Message, parseMessage } from "@spi-code/contracts";
import { expect, it, vi } from "vitest";
import { APPENDIX_A_TOOLS } from "../tools/tool-names.js";
import {
  type ConversationBackend,
  conversationHandler,
  createConversationBackend,
} from "./conversation.js";

const list: Message = { version: 1, id: "list", kind: "request", type: "models.list", payload: {} };
const turn: Message = {
  version: 1,
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
    { type: "signin.state", payload: { signedIn: true } },
    { type: "models.result" },
    { type: "turn.delta" },
    { type: "turn.end", payload: { reason: "completed" } },
  ]);
});

function fakeBackend(): ConversationBackend {
  return {
    generation: 1,
    models: vi.fn(async () => [{ id: "stub", name: "Stub" }]),
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
  backend.models = vi.fn(async () => []);
  const send = vi.fn();
  await conversationHandler(backend, send)(turn);
  expect(backend.turn).not.toHaveBeenCalled();
  expect(backend.stop).not.toHaveBeenCalled();
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
    { version: 1, id: "turn", kind: "event", type: "signin.state", payload: { signedIn: true } },
  ]);
  expect(backend.stop).not.toHaveBeenCalled();
  expect(messages.at(-1)).toMatchObject({ type: "turn.end", payload: { reason: "error" } });
});

it.each(["signin.state", "session.ended", "tool.call"])("rejects token fields on %s", (type) => {
  const payload =
    type === "signin.state"
      ? { signedIn: true }
      : type === "session.ended"
        ? { reason: "credential_changed" }
        : { name: "spi_brief", callId: "call", arguments: {}, outcome: "completed" };
  expect(
    parseMessage({
      version: 1,
      id: "x",
      kind: "event",
      type,
      payload: { ...payload, token: "secret" },
    }).ok,
  ).toBe(false);
});
