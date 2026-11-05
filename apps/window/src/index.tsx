// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Message, PROTOCOL_VERSION, parseMessage } from "@spi-code/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Shell } from "./app/Shell.js";
import { hostMessageHandler } from "./host-message.js";
import { settleTurn, signInStatus } from "./turn-state.js";
import "./theme/tokens.css";
import "./style.css";

declare global {
  interface Window {
    spi: {
      proof: boolean;
      openExternal(url: string): Promise<boolean>;
      postMessage(message: Message): void;
      onMessage(listener: (message: unknown) => void): () => void;
    };
  }
}

function send(message: Message): void {
  const parsed = parseMessage(message);
  if (!parsed.ok) throw new Error("Window generated an invalid message");
  window.spi.postMessage(parsed.message);
}

function App() {
  const [status, setStatus] = useState("Connecting to host...");
  const [signedIn, setSignedIn] = useState(false);
  const [stub, setStub] = useState(false);
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [text, setText] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [activeRequestId, setActiveRequestId] = useState<string>();
  const activeTurn = useRef<string | undefined>(undefined);
  const requestIds = useRef(new Set<string>());
  const request = useCallback((message: Message): void => {
    requestIds.current.add(message.id);
    send(message);
  }, []);
  const busy = activeRequestId !== undefined;
  const [ended, setEnded] = useState("");
  useEffect(() => {
    let proofStarted = false;
    return window.spi.onMessage(
      hostMessageHandler(
        (message) => {
          activeTurn.current = settleTurn(activeTurn.current, message);
          setActiveRequestId(activeTurn.current);
          switch (message.type) {
            case "host.hello":
              request({
                version: PROTOCOL_VERSION,
                id: "window-ping",
                kind: "request",
                type: "ping",
                payload: {},
              });
              request({
                version: PROTOCOL_VERSION,
                id: "catalog",
                kind: "request",
                type: "models.list",
                payload: {},
              });
              break;
            case "signin.state":
              setSignedIn(message.payload.signedIn);
              setStub(message.payload.mode === "stub");
              setStatus(signInStatus(message.payload));
              break;
            case "models.result": {
              setModels(message.payload.models);
              const selected = message.payload.models[0]?.id ?? "";
              setModel((current) =>
                message.payload.models.some(({ id }) => id === current) ? current : selected,
              );
              if (window.spi.proof && !proofStarted && selected) {
                proofStarted = true;
                const id = crypto.randomUUID();
                activeTurn.current = id;
                setActiveRequestId(id);
                request({
                  version: PROTOCOL_VERSION,
                  id,
                  kind: "request",
                  type: "turn.start",
                  payload: {
                    modelId: selected,
                    prompt:
                      "Call spi_brief with empty arguments, then reply with one short sentence.",
                  },
                });
              }
              break;
            }
            case "turn.delta":
              setText((current) => current + message.payload.text);
              break;
            case "tool.call":
              setTools((current) => [
                ...current,
                `${message.payload.name}: ${message.payload.outcome}`,
              ]);
              break;
            case "session.ended":
              setEnded(`Session ended: ${message.payload.reason.replaceAll("_", " ")}`);
              break;
            case "error":
              setStatus(message.payload.message);
              break;
          }
        },
        () => setStatus("Invalid host message rejected"),
        () => activeTurn.current,
        (id) => requestIds.current.has(id),
      ),
    );
  }, [request]);
  return (
    <div className="turn-panel">
      <h2>Copilot</h2>
      <p role="status">{status}</p>
      {ended && <p role="status">{ended}</p>}
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          request({
            version: PROTOCOL_VERSION,
            id: "refresh",
            kind: "request",
            type: "models.list",
            payload: {},
          })
        }
      >
        Refresh sign-in and models
      </button>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const id = crypto.randomUUID();
          activeTurn.current = id;
          setActiveRequestId(id);
          setEnded("");
          setText("");
          setTools([]);
          request({
            version: PROTOCOL_VERSION,
            id,
            kind: "request",
            type: "turn.start",
            payload: { modelId: model, prompt },
          });
        }}
      >
        <label htmlFor="model">Model ({models.length})</label>
        <select
          id="model"
          value={model}
          disabled={busy}
          onChange={(event) => setModel(event.target.value)}
        >
          {models.map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <label htmlFor="prompt">Prompt</label>
        <textarea
          id="prompt"
          value={prompt}
          disabled={busy}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <button type="submit" disabled={(!signedIn && !stub) || !model || !prompt.trim() || busy}>
          {busy ? "Streaming..." : "Send"}
        </button>
      </form>
      <section aria-label="Copilot response">
        <h2>Copilot</h2>
        <pre>{text}</pre>
      </section>
      <section aria-label="Tool events">
        <h2>Gated tools</h2>
        <pre>{tools.join("\n")}</pre>
      </section>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing window root");
createRoot(root).render(
  <Shell>
    <App />
  </Shell>,
);
