// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import {
  type Message,
  PROTOCOL_VERSION,
  parseMessage,
  type WatchBriefing,
} from "@spi-code/contracts";
import { Menu, Notification, nativeImage, nativeTheme, Tray } from "electron";

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

/** Distinct interruptions in a brief, one per item however many ids it carries. */
export function interruptions(briefing: Pick<WatchBriefing, "focus" | "rest">) {
  const all = [...briefing.focus, ...briefing.rest];
  const identities = new Map<string, Set<string>>();
  for (const item of all) {
    const ids = new Set([item.id, ...item.ids]);
    for (const id of ids) {
      for (const alias of identities.get(id) ?? []) ids.add(alias);
    }
    for (const id of ids) identities.set(id, ids);
  }
  return new Set(
    all.filter(({ attention }) => attention === "interrupt").map(({ id }) => identities.get(id)),
  ).size;
}

function notifyNative(open: () => void) {
  return (title: string, body: string | undefined) => {
    if (!Notification.isSupported()) return;
    const notification = new Notification(body === undefined ? { title } : { title, body });
    notification.on("click", open);
    notification.show();
  };
}

type Snapshot = Extract<Message, { type: "view.snapshot" }>["payload"];
type Progress = Extract<Message, { type: "sweep.progress" }>["payload"];

/** Sources whose sign-in failure core raises only when glab needs a sign-in. */
const GLAB_SOURCES = new Set(["upstream", "radar"]);

/** A wall-clock HH:MM in the machine's zone. */
export function clockTime(iso: string) {
  const at = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** The dock badge for the Today count: nothing at zero, "9+" past nine. */
export function dockBadge(count: number) {
  if (count <= 0) return "";
  return count > 9 ? "9+" : String(count);
}

const settled = ({ sources }: Progress) =>
  sources.filter(({ state }) => state !== "waiting" && state !== "reading" && state !== "throttled")
    .length;

/** The sources a finished sweep could not read for want of a sign-in; null where none is named. */
export const signinFailures = (progress: Progress): (string | null)[] => [
  ...progress.sources.flatMap((source) =>
    source.state === "failed" && source.code === "signin" ? [source.source] : [],
  ),
  ...(progress.outcome === "failed" && progress.code === "signin" ? [progress.source ?? null] : []),
];

type SigninTool = "gh" | "glab";
export type ToolStates = ReadonlyMap<string, string>;

/**
 * The tool behind a sweep's sign-in failures, or null when it cannot be told. upstream and radar
 * fail for sign-in only when glab needs one; any other source (auth checks both tools) is
 * attributed only through the tool setup reports signed out, gh first.
 */
export function signedOutTool(failures: readonly (string | null)[], tools: ToolStates) {
  let found: SigninTool | null = null;
  for (const source of failures) {
    const tool: SigninTool | null =
      source !== null && GLAB_SOURCES.has(source)
        ? "glab"
        : tools.get("gh") === "signed-out"
          ? "gh"
          : tools.get("glab") === "signed-out"
            ? "glab"
            : null;
    if (tool === "gh") return tool;
    found ??= tool;
  }
  return found;
}

export interface SweepTrayOptions {
  /** Whether the window is out of sight, so the hand-over is worth a notification. */
  hidden?: () => boolean;
  notify?: (title: string, body: string | undefined) => void;
  /** Sends a request to the host; false when no host is connected. */
  request?: (message: Message) => boolean;
  /** Shows the window on the sweep's Evidence. */
  viewSweep?: () => void;
  /** Sets the macOS dock badge; omitted where the platform has none. */
  badge?: (text: string) => void;
  /** The clock that decides whether the next sweep's time is still ahead. */
  now?: () => number;
}

export function createSweepTray(
  open: () => void,
  quit: () => void,
  {
    hidden = () => false,
    notify = notifyNative(open),
    request = () => false,
    viewSweep = open,
    badge,
    now = Date.now,
  }: SweepTrayOptions = {},
) {
  const tray = new Tray(dotImage("unread"));
  let latest: Snapshot | undefined;
  let deferred = false;
  let armed = false;
  let handedOver = false;
  /** The first sweep's running, stopped or ready text, kept over budget updates until it moves on. */
  let phase: { text: string; dot?: Dot } | null = null;
  /** Watch off, a signed-out gh or a lost host: shown until the host reports again. */
  let halt: { text: string; dot: Dot } | null = null;
  /** A later sweep in flight, read for its count while the dot keeps the committed tone. */
  let running: Progress | undefined;
  let sweeping = false;
  /** The latest finished sweep's sign-in failures, attributed to a tool at render time. */
  let signin: (string | null)[] = [];
  /** Each tool's state as setup last validated it. */
  let tools: ToolStates = new Map();
  let watchReady = true;
  let nextSweepAt: string | null = null;
  let shownMenu = "";
  let shownBadge = "";
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const state = (): [Dot, string] => {
    if (latest?.areas.some(({ envelope }) => envelope.state === "failed"))
      return ["failed", "Read failed"];
    if (
      deferred ||
      latest?.areas.some(
        ({ envelope }) => envelope.state === "incomplete" || envelope.state === "stale",
      )
    )
      return ["warning", "Areas cut or stale"];
    if (!latest || latest.areas.some(({ envelope }) => envelope.state === "unread"))
      return ["unread", "First sweep running"];
    if (latest.areas.every(({ envelope }) => envelope.inferred)) return ["unread", "Inferred"];
    return ["fresh", "All fresh"];
  };
  const today = () => (latest ? interruptions(latest.briefing) : 0);
  const tooltip = (): [Dot, string] => {
    if (halt) return [halt.dot, halt.text];
    const [dot, text] = state();
    if (phase) return [phase.dot ?? dot, phase.text];
    if (!latest) return [dot, text];
    const swept = clockTime(latest.sweptAt);
    const signedOut = signedOutTool(signin, tools);
    // A routine sweep keeps the committed tone, signed-out red included.
    if (running)
      return [
        signedOut ? "failed" : dot,
        `Sweeping ${settled(running)} of ${running.sources.length} · last ${swept}`,
      ];
    if (signedOut) return ["failed", `Can't read: ${signedOut} signed out`];
    const count = today();
    if (count > 0) return [dot, `${count} need${count === 1 ? "s" : ""} you · swept ${swept}`];
    return [dot, `${text} · swept ${swept}`];
  };
  const statusLine = (fallback: string) => {
    if (running) return `Sweeping · ${settled(running)} of ${running.sources.length}`;
    if (halt || !latest) return fallback;
    const ahead = nextSweepAt !== null && Date.parse(nextSweepAt) > now();
    return `Swept ${clockTime(latest.sweptAt)}${ahead && nextSweepAt ? ` · next ${clockTime(nextSweepAt)}` : ""}`;
  };
  const sweepNow = () => {
    const sent = request({
      version: PROTOCOL_VERSION,
      id: randomUUID(),
      kind: "request",
      type: "sweep.request",
      payload: { now: true },
    });
    if (!sent) console.warn("Sweep now could not reach the host");
  };
  const render = () => {
    const [dot, text] = tooltip();
    tray.setImage(dotImage(dot));
    tray.setToolTip(`SPI Code - ${text}`);
    const status = statusLine(text);
    const enabled = !halt && watchReady && !sweeping;
    const key = JSON.stringify([status, enabled]);
    if (key !== shownMenu) {
      shownMenu = key;
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: status, enabled: false },
          { label: "Sweep now", enabled, click: sweepNow },
          { label: "View sweep", click: viewSweep },
          { type: "separator" },
          { label: "Open", click: open },
          { label: "Quit", click: quit },
        ]),
      );
    }
    const counted = dockBadge(today());
    if (badge && counted !== shownBadge) {
      shownBadge = counted;
      badge(counted);
    }
    // Never show an expired time as a promise: drop the next sweep from the menu when it passes.
    clearTimeout(expiry);
    expiry = undefined;
    const left = nextSweepAt === null ? 0 : Date.parse(nextSweepAt) - now();
    // Capped: setTimeout fires at once past 2^31 - 1 ms, and a re-render re-arms it.
    if (left > 0 && !running && latest && !halt)
      expiry = setTimeout(render, Math.min(left + 1, 2 ** 31 - 1));
  };
  const reset = () => {
    latest = undefined;
    deferred = false;
    phase = null;
    running = undefined;
    sweeping = false;
    nextSweepAt = null;
  };
  tray.on("click", open);
  render();
  return {
    observe(input: unknown) {
      const parsed = parseMessage(input);
      if (!parsed.ok) {
        console.warn("Rejected invalid host message for the sweep-state dot");
        return;
      }
      const message = parsed.message;
      if (halt?.text === "Host reconnecting") halt = null;
      if (message.type === "view.snapshot") {
        latest = message.payload;
        halt = null;
        phase = armed ? { text: "Today is ready" } : null;
        render();
        if (armed) {
          armed = false;
          handedOver = true;
          if (hidden()) {
            const count = interruptions(message.payload.briefing);
            notify(
              "Today is ready",
              count === 0
                ? undefined
                : `${count} interruption${count === 1 ? " needs" : "s need"} you.`,
            );
          }
        }
      } else if (message.type === "sweep.progress") {
        const progress = message.payload;
        sweeping = progress.outcome === "running";
        if (latest) {
          running = progress.outcome === "running" ? progress : undefined;
          if (running) phase = null;
          const failures = signinFailures(progress);
          if (progress.outcome === "committed") signin = failures;
          else if (progress.outcome === "failed" && failures.length) signin = failures;
          render();
          return;
        }
        if (!progress.first) {
          render();
          return;
        }
        if (!handedOver) armed = true;
        if (progress.outcome === "failed") {
          phase = { text: "First sweep stopped", dot: "failed" };
        } else if (progress.outcome === "running") {
          phase = {
            text: `First sweep running · ${settled(progress)} of ${progress.sources.length}`,
          };
        }
        render();
      } else if (message.type === "sweep.status") {
        deferred = message.payload.deferredAreas.length > 0;
        nextSweepAt = message.payload.nextSweepAt;
        render();
      } else if (message.type === "setup.state") {
        watchReady = message.payload.watchReady;
        tools = new Map(message.payload.tools.map(({ tool, state }) => [tool, state]));
        if (watchReady) {
          if (halt?.text !== "Host stopped") halt = null;
          render();
          return;
        }
        reset();
        const gh = message.payload.tools.find(({ tool }) => tool === "gh");
        halt =
          gh?.state === "signed-out"
            ? { text: "Can't read: gh signed out", dot: "failed" }
            : { text: "Watch is off", dot: "unread" };
        render();
      } else if (message.type === "error" && message.payload.code === "host_unavailable") {
        halt = { text: "Host stopped", dot: "failed" };
        render();
      }
    },
    disconnected() {
      reset();
      halt = { text: "Host reconnecting", dot: "failed" };
      render();
    },
    present: () => !tray.isDestroyed(),
    dispose: () => {
      clearTimeout(expiry);
      tray.destroy();
    },
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
  outgoing: (message: unknown) => void = () => {},
) {
  let dispose = () => {};
  let host: P | undefined;
  return {
    connect() {
      dispose();
      const window = makeChannel();
      const channel = makeChannel();
      host = channel.port1;
      window.port2.on("message", ({ data, ports }) => {
        channel.port1.postMessage(data, ports);
        try {
          outgoing(data);
        } catch (error) {
          console.error("Desktop failed to observe an outgoing host request", error);
        }
      });
      channel.port1.on("message", ({ data, ports }) => {
        window.port2.postMessage(data, ports);
        try {
          observe(data);
        } catch (error) {
          console.error("Sweep-state dot failed to observe a host message", error);
        }
      });
      window.port2.start();
      channel.port1.start();
      dispose = () => {
        window.port2.close();
        channel.port1.close();
        host = undefined;
      };
      return { port1: window.port1, port2: channel.port2 };
    },
    /** Sends desktop main's own request to the host on the live relay; false when none is up. */
    request(message: Message) {
      const parsed = parseMessage(message);
      if (!parsed.ok || parsed.message.kind !== "request")
        throw new Error("Desktop generated an invalid host request");
      if (!host) return false;
      host.postMessage(parsed.message, []);
      return true;
    },
    dispose: () => dispose(),
  };
}
