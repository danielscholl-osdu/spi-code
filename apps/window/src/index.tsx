// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Message, PROTOCOL_VERSION, parseMessage } from "@spi-code/contracts";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Shell } from "./app/Shell.js";
import "./theme/tokens.css";
import "./style.css";

declare global {
  interface Window {
    spi: {
      proof: boolean;
      openExternal(url: string): Promise<boolean>;
      setAppearance?(theme: "light" | "dark"): Promise<boolean>;
      postMessage(message: Message): void;
      onMessage(listener: (message: unknown) => void): () => void;
      onNavigate?(listener: (destination: unknown) => void): () => void;
      onLeave?(listener: () => void): () => void;
    };
  }
}

function send(message: Message): void {
  const parsed = parseMessage(message);
  if (!parsed.ok) throw new Error("Window generated an invalid message");
  window.spi.postMessage(parsed.message);
}

function ProofTurnHarness() {
  useEffect(() => {
    let proofStarted = false;
    return window.spi.onMessage((input) => {
      const parsed = parseMessage(input);
      if (!parsed.ok || parsed.message.kind === "request") return;
      const message = parsed.message;
      switch (message.type) {
        case "host.hello":
          send({
            version: PROTOCOL_VERSION,
            id: "window-ping",
            kind: "request",
            type: "ping",
            payload: {},
          });
          send({
            version: PROTOCOL_VERSION,
            id: "catalog",
            kind: "request",
            type: "models.list",
            payload: {},
          });
          break;
        case "models.result": {
          const selected = message.payload.models[0]?.id;
          if (!proofStarted && selected) {
            proofStarted = true;
            send({
              version: PROTOCOL_VERSION,
              id: crypto.randomUUID(),
              kind: "request",
              type: "turn.start",
              payload: {
                modelId: selected,
                prompt: "Call spi_brief with empty arguments, then reply with one short sentence.",
              },
            });
          }
          break;
        }
      }
    });
  }, []);
  return null;
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing window root");
createRoot(root).render(
  <>
    <Shell />
    {window.spi.proof && <ProofTurnHarness />}
  </>,
);
