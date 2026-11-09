// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

const { contextBridge, ipcRenderer } = require("electron");

let port;
let fixture = false;
const listeners = new Set();
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
      version: 3,
      id: "bad",
      kind: "request",
      type: "ping",
      payload: { extra: true },
    });
  });
}
