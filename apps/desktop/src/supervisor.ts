// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT
//
// Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import { type Message, PROTOCOL_VERSION } from "@spi-code/contracts";

const INITIAL_RESTART_DELAY = 500;
const MAX_RESTART_DELAY = 10000;
const MAX_RESTART_ATTEMPTS = 7;
const STABLE_RUN_MS = 60000;

interface HostProcess {
  once(event: "spawn", listener: () => void): unknown;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  kill(): boolean;
}

interface Clock {
  schedule(delay: number, callback: () => void): () => void;
}

const clock: Clock = {
  schedule(delay, callback) {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
};

interface Options<Host extends HostProcess> {
  spawn(): Host;
  onSpawn(host: Host): void;
  onGiveUp(message: Extract<Message, { type: "error" }>): void;
  clock?: Clock;
  log?(message: string): void;
}

export class HostSupervisor<Host extends HostProcess> {
  private desiredRunning = false;
  private attempts = 0;
  private cancelRestart: (() => void) | undefined;
  private cancelStable: (() => void) | undefined;
  private active: { host: Host; exited: Promise<void>; stopping: boolean } | undefined;
  private readonly clock: Clock;

  constructor(private readonly options: Options<Host>) {
    this.clock = options.clock ?? clock;
  }

  start(): void {
    if (this.desiredRunning) return;
    this.desiredRunning = true;
    this.attempts = 0;
    this.launch();
  }

  async stop(): Promise<void> {
    this.desiredRunning = false;
    this.cancelRestart?.();
    this.cancelRestart = undefined;
    this.cancelStable?.();
    this.cancelStable = undefined;
    const run = this.active;
    if (!run) return;
    if (!run.stopping) {
      run.stopping = true;
      if (!run.host.kill()) {
        run.stopping = false;
        throw new Error("Could not stop host");
      }
    }
    await run.exited;
  }

  private launch(): void {
    if (!this.desiredRunning || this.active) return;
    let host: Host;
    try {
      host = this.options.spawn();
    } catch (error) {
      this.restart(`Host launch failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    let exited!: () => void;
    const run = {
      host,
      exited: new Promise<void>((resolve) => {
        exited = resolve;
      }),
      stopping: false,
    };
    this.active = run;
    host.once("exit", (code) => {
      exited();
      if (this.active !== run) return;
      this.active = undefined;
      this.cancelStable?.();
      this.cancelStable = undefined;
      if (this.desiredRunning) this.restart(`Host exited unexpectedly (${code})`);
    });
    host.once("spawn", () => {
      if (this.active !== run || !this.desiredRunning || run.stopping) return;
      // A quick spawn/hello is not recovery: crash loops must still exhaust their budget.
      this.cancelStable = this.clock.schedule(STABLE_RUN_MS, () => {
        this.cancelStable = undefined;
        this.attempts = 0;
      });
      this.options.onSpawn(host);
    });
  }

  private restart(reason: string): void {
    (this.options.log ?? console.error)(reason);
    if (!this.desiredRunning || this.cancelRestart) return;
    if (this.attempts >= MAX_RESTART_ATTEMPTS) {
      this.desiredRunning = false;
      this.options.onGiveUp({
        version: PROTOCOL_VERSION,
        id: "host-supervisor",
        kind: "response",
        type: "error",
        payload: {
          code: "host_unavailable",
          message: "Host stopped after repeated crashes. Restart SPI Code to reconnect.",
        },
      });
      return;
    }
    const delay = Math.min(INITIAL_RESTART_DELAY * 2 ** this.attempts++, MAX_RESTART_DELAY);
    this.cancelRestart = this.clock.schedule(delay, () => {
      this.cancelRestart = undefined;
      this.launch();
    });
  }
}
