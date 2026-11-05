// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { CopilotSession } from "@github/copilot-sdk";
import { type Message, PROTOCOL_VERSION } from "@spi-code/contracts";
import { registrySource } from "../copilot/registry-source.js";
import { CopilotRuntime, streamTurn } from "../copilot/runtime.js";
import { captureLoginShellPath } from "../env/shell-environment.js";
import { FakeSession } from "../testing/fake-session.js";
import { ToolRefusedError } from "../tools/registry.js";
import { APPENDIX_A_TOOLS } from "../tools/tool-names.js";

export interface ConversationBackend {
  readonly mode: "gh" | "stub";
  readonly generation: number;
  models(): Promise<{ id: string; name: string }[]>;
  turn(model: string, prompt: string, delta: (text: string) => void): Promise<void>;
  endSession(): void;
  stop(): Promise<void>;
}

export async function createConversationBackend(
  appDataDir: string,
  stub: boolean,
  observe: Parameters<typeof registrySource>[0],
): Promise<ConversationBackend> {
  const source = registrySource(observe);
  if (stub) {
    const fake = new FakeSession(source);
    return {
      mode: "stub",
      generation: 1,
      models: async () => [{ id: "stub", name: "Stub model (no Copilot seat)" }],
      endSession() {},
      stop: async () => {},
      async turn(_model, _prompt, delta) {
        for (const { name } of APPENDIX_A_TOOLS) {
          try {
            await fake.callTool(name, {});
          } catch (error) {
            if (!(error instanceof ToolRefusedError)) throw error;
          }
        }
        let effectRan = false;
        try {
          await fake.requestPermission(
            {
              kind: "shell",
              canOfferSessionApproval: false,
              commands: [],
              fullCommandText: "echo denied",
              hasWriteFileRedirection: false,
              intention: "Smoke denial probe",
              possiblePaths: [],
              possibleUrls: [],
            },
            () => {
              effectRan = true;
            },
          );
          throw new Error("Built-in permission was not refused");
        } catch (error) {
          if (
            effectRan ||
            !(error instanceof Error) ||
            !error.message.includes("permission refused")
          )
            throw error;
        }
        delta("Stub turn reached every gated tool; unsafe tiers and the built-in were refused.");
      },
    };
  }
  const captured = await captureLoginShellPath();
  const runtime = new CopilotRuntime(
    { appDataDir, capturedPath: captured.path },
    undefined,
    source,
  );
  let session: CopilotSession | undefined;
  let sessionModel: string | undefined;
  return {
    mode: "gh",
    get generation() {
      return runtime.clientGeneration;
    },
    models: async () => (await runtime.listModels()).models.map(({ id, name }) => ({ id, name })),
    endSession() {
      session = undefined;
      sessionModel = undefined;
    },
    stop: () => runtime.stop(),
    async turn(model, prompt, delta) {
      if (session && sessionModel !== model) {
        const previous = session;
        session = undefined;
        sessionModel = undefined;
        await previous.disconnect();
      }
      session ??= await runtime.createSession(model);
      sessionModel = model;
      await streamTurn(session, prompt, delta);
    },
  };
}

export function conversationHandler(
  backend: ConversationBackend,
  send: (message: Message) => void,
) {
  let generation = 0;
  let hasSession = false;
  return async (message: Message): Promise<void> => {
    const envelope = { version: PROTOCOL_VERSION, id: message.id, kind: "event" } as const;
    let authenticated = false;
    let failureMessage = "Copilot request failed. Check gh sign-in and retry.";
    try {
      if (message.type !== "models.list" && message.type !== "turn.start") return;
      const models = await backend.models();
      authenticated = true;
      if (hasSession && generation !== backend.generation) {
        backend.endSession();
        hasSession = false;
        send({
          ...envelope,
          type: "session.ended",
          payload: { reason: "credential_changed" },
        });
      }
      generation = backend.generation;
      send({
        ...envelope,
        type: "signin.state",
        payload: { signedIn: backend.mode === "gh", mode: backend.mode },
      });
      send({
        ...envelope,
        kind: "response",
        type: "models.result",
        payload: { models },
      });
      if (message.type === "turn.start") {
        failureMessage = "The selected model is no longer available. Refresh models and retry.";
        if (!models.some(({ id }) => id === message.payload.modelId))
          throw new Error("Requested model is not in the current catalog");
        failureMessage = "Copilot turn failed. Retry the turn.";
        hasSession = true;
        await backend.turn(message.payload.modelId, message.payload.prompt, (text) =>
          send({
            ...envelope,
            type: "turn.delta",
            payload: { text },
          }),
        );
        generation = backend.generation;
        send({
          ...envelope,
          type: "turn.end",
          payload: { reason: "completed" },
        });
      }
    } catch {
      // Only fixed public errors cross this boundary, never SDK errors or credentials.
      if (!authenticated) {
        await backend.stop();
        backend.endSession();
        hasSession = false;
        send({
          ...envelope,
          type: "signin.state",
          payload: { signedIn: false, mode: backend.mode },
        });
        send({ ...envelope, type: "session.ended", payload: { reason: "authentication_failed" } });
      }
      send({
        ...envelope,
        kind: "response",
        type: "error",
        payload: {
          code: "copilot_failed",
          message: failureMessage,
        },
      });
      if (message.type === "turn.start")
        send({
          ...envelope,
          type: "turn.end",
          payload: { reason: "error" },
        });
    }
  };
}
