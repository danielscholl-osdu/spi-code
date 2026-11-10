// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

const { contextBridge, ipcRenderer } = require("electron");

let port;
let fixture = false;
const listeners = new Set();
const navigators = new Set();
let pendingDestination;
// The closed set of places desktop main may send the window to; anything else is dropped here.
const DESTINATIONS = new Set(["evidence", "readiness"]);
function windowDestination(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const keys = Object.keys(input);
  if (
    keys.length === 2 &&
    keys.includes("to") &&
    keys.includes("item") &&
    input.to === "today" &&
    typeof input.item === "string" &&
    input.item.length <= 256 &&
    input.item.length > 0 &&
    input.item.trim() === input.item &&
    !["__proto__", "constructor", "prototype"].includes(input.item) &&
    !/(?:^|[:/\\])\.\.(?:[/\\]|$)/.test(input.item) &&
    !/%2e|\.\.(?:%2f|\/)|(?:%2f|\/)\.\./i.test(input.item) &&
    !/^(?:[./~\\]|[a-z]:\/|(?:https?|file|data|javascript|vbscript|mailto):)|\\|:\/\/|[\p{Cc}\u2028\u2029]/iu.test(
      input.item,
    ) &&
    (!input.item.includes("/") || /^[a-z][a-z0-9-]*:/i.test(input.item))
  )
    return { to: "today", item: input.item };
  if (keys.length !== 1 || keys[0] !== "to") return undefined;
  if (typeof input.to !== "string" || !DESTINATIONS.has(input.to)) return undefined;
  return { to: input.to };
}
contextBridge.exposeInMainWorld("spi", {
  proof: process.argv.includes("--spi-proof"),
  openExternal(url) {
    return ipcRenderer.invoke("external:open", url);
  },
  setAppearance(theme) {
    return ipcRenderer.invoke("window:appearance", theme);
  },
  postMessage(message) {
    if (fixture) {
      ipcRenderer.send("smoke:request", message);
      return;
    }
    if (!port) throw new Error("Host port is not connected");
    if (
      process.argv.includes("--spi-proof") &&
      (message.type === "turn.start" ||
        (process.argv.includes("--spi-smoke") && message.type === "view.subscribe"))
    )
      ipcRenderer.send("proof:message", message);
    port.postMessage(message);
  },
  onMessage(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  onNavigate(listener) {
    navigators.add(listener);
    if (pendingDestination) {
      const destination = pendingDestination;
      pendingDestination = undefined;
      listener(destination);
    }
    return () => navigators.delete(listener);
  },
});
ipcRenderer.on("window:navigate", (_event, input) => {
  const destination = windowDestination(input);
  if (!destination) return;
  // Held for the renderer when it has not subscribed yet, so a tray click before it mounts lands.
  if (navigators.size === 0) pendingDestination = destination;
  for (const listener of navigators) listener({ ...destination });
});
ipcRenderer.on("host:port", (event) => {
  if (port) port.close();
  port = event.ports[0];
  if (!port) throw new Error("Host port was not transferred");
  port.onmessage = ({ data }) => {
    for (const listener of listeners) listener(data);
    if (process.argv.includes("--spi-proof")) ipcRenderer.send("proof:message", data);
  };
  port.start();
});
if (process.argv.includes("--spi-smoke")) {
  ipcRenderer.on("smoke:fixture", (_event, message) => {
    fixture = true;
    for (const listener of listeners) listener(message);
  });
  ipcRenderer.on("smoke:malformed", () => {
    if (!port) throw new Error("Smoke port is not connected");
    // Current PROTOCOL_VERSION, so the host rejects the probe for its extra field alone.
    port.postMessage({
      version: 4,
      id: "bad",
      kind: "request",
      type: "ping",
      payload: { extra: true },
    });
  });
}
