// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { setImmediate, setTimeout } from "node:timers/promises";
import type { SessionEvent } from "@github/copilot-sdk";
import type { ThreadCopilotSession, ThreadSessionOptions } from "../../src/copilot/runtime.js";
import type { HostOp, TraceOp } from "./trace.js";

type Claim = { kind: TraceOp["op"]; sessionId?: string; resolve: (op: TraceOp) => void };
type Listener = (event: SessionEvent) => void;

const PLAYED_BY_THE_TRACE = new Set<TraceOp["op"]>(["trace", "event", "permission", "tool"]);

function describe(op: TraceOp): string {
  return op.op === "host" ? `host ${op.action}` : op.op;
}

/**
 * Plays a recorded trace to the adapter: the runtime's calls (open, history, send, abort, release)
 * must come in the recorded order, each recorded event reaches the session's listeners at its
 * recorded place, and permission and tool records stay records.
 */
export class TracePlayer {
  /** Each SDK field read on a played event, as `<event type> <path>`. */
  readonly reads = new Set<string>();
  readonly failed: Promise<never>;
  readonly ended: Promise<void>;
  private index = 0;
  private claims: Claim[] = [];
  private wake: () => void = () => {};
  private fail: (error: Error) => void = () => {};
  private end: () => void = () => {};
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    private readonly ops: readonly TraceOp[],
    private readonly stallMs = 3000,
  ) {
    this.failed = new Promise<never>((_, reject) => {
      this.fail = reject;
    });
    this.failed.catch(() => {});
    this.ended = new Promise((resolve) => {
      this.end = resolve;
    });
    void this.run().catch((error: unknown) =>
      this.fail(error instanceof Error ? error : new Error(String(error))),
    );
  }

  /** The next host action the recording made, or undefined once the trace has none left. */
  async host(): Promise<HostOp | undefined> {
    if (!this.ops.slice(this.index).some(({ op }) => op === "host")) return undefined;
    return (await this.claim("host")) as HostOp;
  }

  claim(kind: TraceOp["op"], sessionId?: string): Promise<TraceOp> {
    return new Promise((resolve) => {
      this.claims.push({ kind, ...(sessionId === undefined ? {} : { sessionId }), resolve });
      this.wake();
    });
  }

  private async run() {
    while (this.index < this.ops.length) {
      const op = this.ops[this.index] as TraceOp;
      if (PLAYED_BY_THE_TRACE.has(op.op)) {
        this.index += 1;
        if (op.op === "event") {
          for (const listener of [...(this.listeners.get(op.sessionId) ?? [])])
            listener(this.track(op.event));
          await setImmediate();
        }
        continue;
      }
      const claim = await this.awaitClaim(op);
      this.index += 1;
      claim.resolve(op);
      await setImmediate();
    }
    this.end();
    for (;;) {
      const claim = this.claims.shift();
      if (claim) {
        if (claim.kind !== "release" && claim.kind !== "abort") {
          this.fail(new Error(`The adapter called ${claim.kind} after the trace ended.`));
          return;
        }
        claim.resolve({ op: claim.kind, sessionId: claim.sessionId ?? "" });
        continue;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private async awaitClaim(op: TraceOp): Promise<Claim> {
    const deadline = Date.now() + this.stallMs;
    for (;;) {
      const at = this.claims.findIndex(
        ({ kind, sessionId }) =>
          kind === op.op &&
          (sessionId === undefined || !("sessionId" in op) || op.sessionId === sessionId),
      );
      if (at >= 0) return this.claims.splice(at, 1)[0] as Claim;
      const left = deadline - Date.now();
      if (left <= 0) {
        const waiting = this.claims.map(({ kind }) => kind).join(", ") || "nothing";
        throw new Error(
          `Replay stalled at op ${this.index + 1} (${describe(op)}); the adapter is waiting on ${waiting}.`,
        );
      }
      const timer = new AbortController();
      await Promise.race([
        new Promise<void>((resolve) => {
          this.wake = resolve;
        }),
        setTimeout(left, undefined, { signal: timer.signal }).catch(() => {}),
      ]);
      timer.abort();
    }
  }

  private track(event: SessionEvent): SessionEvent {
    const reads = this.reads;
    const wrap = (value: object, path: string): object =>
      new Proxy(value, {
        get(target, key, receiver) {
          const entry = Reflect.get(target, key, receiver);
          if (typeof key !== "string" || key === "toJSON" || key === "then") return entry;
          const at = path ? `${path}.${key}` : key;
          if (at !== "type") reads.add(`${event.type} ${at}`);
          return entry && typeof entry === "object" ? wrap(entry, at) : entry;
        },
      });
    return wrap(event, "") as SessionEvent;
  }

  /** The adapter-facing runtime: openThreadSession resolves to a session played from the trace. */
  openThreadSession = async (
    _workspace: unknown,
    options: ThreadSessionOptions,
  ): Promise<ThreadCopilotSession> => {
    const op = await this.claim("open");
    if (op.op !== "open") throw new Error("Expected an open");
    if (op.resumeId !== options.resumeId) {
      const error = new Error(
        `The adapter resumed ${options.resumeId ?? "nothing"}; the trace resumed ${op.resumeId ?? "nothing"}.`,
      );
      this.fail(error);
      throw error;
    }
    return this.session(op.sessionId);
  };

  private session(sessionId: string): ThreadCopilotSession {
    const listeners = new Set<Listener>();
    this.listeners.set(sessionId, listeners);
    let released = false;
    let sandbox: ThreadCopilotSession["sandbox"] = { kind: "confined", backend: "seatbelt" };
    const take = async <K extends TraceOp["op"]>(kind: K) =>
      (await this.claim(kind, sessionId)) as Extract<TraceOp, { op: K }>;
    return {
      sessionId,
      get sandbox() {
        return sandbox;
      },
      get connected() {
        return !released;
      },
      on: ((listener: Listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }) as ThreadCopilotSession["on"],
      getEvents: async () => (await take("history")).events.map((event) => this.track(event)),
      send: async () => {
        await take("send");
        const sent = await take("sent");
        sandbox = sent.sandbox as ThreadCopilotSession["sandbox"];
        return { messageId: sent.messageId, sandbox };
      },
      abort: async () => {
        await take("abort");
      },
      release: async () => {
        released = true;
        await take("release");
      },
      setModel: async () => {
        const op = await take("setModel");
        if (op.result !== "confirmed" && op.result !== "not known")
          throw new Error("Copilot did not confirm the selected model and effort.");
        return op.result;
      },
    };
  }
}

/** Whether a recorded event carries the field at a path such as `data.result.content`. */
export function carries(event: SessionEvent, path: string): boolean {
  let value: unknown = event;
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object" || !(key in value)) return false;
    value = (value as Record<string, unknown>)[key];
  }
  return value !== undefined;
}
