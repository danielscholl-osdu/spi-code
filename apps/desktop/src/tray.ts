// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Message, parseMessage } from "@spi-code/contracts";
import { Menu, nativeImage, nativeTheme, Tray } from "electron";

type Dot = "fresh" | "warning" | "failed" | "unread";

function dotImage(dot: Dot) {
  const colors = nativeTheme.shouldUseDarkColors
    ? {
        fresh: [143, 207, 134],
        warning: [226, 180, 92],
        failed: [236, 138, 110],
        unread: [154, 146, 127],
      }
    : {
        fresh: [58, 118, 51],
        warning: [160, 123, 58],
        failed: [187, 74, 43],
        unread: [108, 101, 87],
      };
  const pixels = Buffer.alloc(32 * 32 * 4);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const radius = Math.hypot(x - 15.5, y - 15.5);
      if (radius > 11 || (dot === "unread" && radius < 8)) continue;
      const offset = (y * 32 + x) * 4;
      const [red = 0, green = 0, blue = 0] = colors[dot];
      pixels.set([blue, green, red, 255], offset);
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: 32, height: 32, scaleFactor: 2 });
}

export function createSweepTray(open: () => void, quit: () => void) {
  const tray = new Tray(dotImage("unread"));
  let latest: Extract<Message, { type: "view.snapshot" }>["payload"] | undefined;
  let deferred = false;
  const paint = (dot: Dot, text: string) => {
    tray.setImage(dotImage(dot));
    tray.setToolTip(`SPI Code - ${text}`);
  };
  const sweep = () => {
    if (latest?.areas.some(({ envelope }) => envelope.state === "failed"))
      paint("failed", "Read failed");
    else if (
      deferred ||
      latest?.areas.some(
        ({ envelope }) => envelope.state === "incomplete" || envelope.state === "stale",
      )
    )
      paint("warning", "Areas cut or stale");
    else if (!latest || latest.areas.some(({ envelope }) => envelope.state === "unread"))
      paint("unread", "First sweep running");
    else if (latest.areas.every(({ envelope }) => envelope.inferred)) paint("unread", "Inferred");
    else paint("fresh", "All fresh");
  };
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open", click: open },
      { label: "Quit", click: quit },
    ]),
  );
  tray.on("click", open);
  paint("unread", "First sweep running");
  return {
    observe(input: unknown) {
      const parsed = parseMessage(input);
      if (!parsed.ok) {
        console.warn("Rejected invalid host message for the sweep-state dot");
        return;
      }
      const message = parsed.message;
      if (message.type === "view.snapshot") {
        latest = message.payload;
        sweep();
      } else if (message.type === "sweep.status") {
        deferred = message.payload.deferredAreas.length > 0;
        sweep();
      } else if (message.type === "setup.state" && !message.payload.watchReady) {
        latest = undefined;
        deferred = false;
        paint("unread", "Watch is off");
      } else if (message.type === "error" && message.payload.code === "host_unavailable") {
        paint("failed", "Host stopped");
      }
    },
    disconnected() {
      latest = undefined;
      deferred = false;
      paint("failed", "Host reconnecting");
    },
    present: () => !tray.isDestroyed(),
    dispose: () => tray.destroy(),
  };
}

interface Port<P> {
  on(event: "message", listener: (event: { data: unknown; ports: P[] }) => void): unknown;
  postMessage(data: unknown, ports: P[]): void;
  start(): void;
  close(): void;
}

export function trayChannel<P extends Port<P>>(
  makeChannel: () => { port1: P; port2: P },
  observe: (message: unknown) => void,
) {
  let dispose = () => {};
  return {
    connect() {
      dispose();
      const window = makeChannel();
      const host = makeChannel();
      window.port2.on("message", ({ data, ports }) => host.port1.postMessage(data, ports));
      host.port1.on("message", ({ data, ports }) => {
        observe(data);
        window.port2.postMessage(data, ports);
      });
      window.port2.start();
      host.port1.start();
      dispose = () => {
        window.port2.close();
        host.port1.close();
      };
      return { port1: window.port1, port2: host.port2 };
    },
    dispose: () => dispose(),
  };
}
