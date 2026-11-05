// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Message, parseMessage } from "@spi-code/contracts";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { settleTurn, signInStatus } from "./turn-state.js";
import "./style.css";

declare global {
  interface Window {
    spi: {
      proof: boolean;
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
  const busy = activeRequestId !== undefined;
  const [ended, setEnded] = useState("");
  useEffect(() => {
    let proofStarted = false;
    return window.spi.onMessage((input) => {
      const parsed = parseMessage(input);
      if (!parsed.ok) {
        setStatus("Invalid host message rejected");
        return;
      }
      const message = parsed.message;
      setActiveRequestId((current) => settleTurn(current, message));
      switch (message.type) {
        case "host.hello":
          send({ version: 1, id: "window-ping", kind: "request", type: "ping", payload: {} });
          send({ version: 1, id: "catalog", kind: "request", type: "models.list", payload: {} });
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
            setActiveRequestId("proof-turn");
            send({
              version: 1,
              id: "proof-turn",
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
    });
  }, []);
  return (
    <main>
      <h1>SPI Code</h1>
      <p role="status">{status}</p>
      {ended && <p role="status">{ended}</p>}
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          send({
            version: 1,
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
          setActiveRequestId(id);
          setEnded("");
          setText("");
          setTools([]);
          send({
            version: 1,
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
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing window root");
createRoot(root).render(<App />);
