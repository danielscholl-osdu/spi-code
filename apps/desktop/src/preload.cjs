// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

const { contextBridge, ipcRenderer } = require("electron");

let port;
const listeners = new Set();
contextBridge.exposeInMainWorld("spi", {
  postMessage(message) {
    if (!port) throw new Error("Host port is not connected");
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
    if (process.argv.includes("--spi-smoke")) ipcRenderer.send("smoke:message", data);
  };
  port.start();
});
if (process.argv.includes("--spi-smoke")) {
  ipcRenderer.on("smoke:malformed", () => {
    if (!port) throw new Error("Smoke port is not connected");
    port.postMessage({
      version: 1,
      id: "bad",
      kind: "request",
      type: "ping",
      payload: { extra: true },
    });
  });
}
