// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { EventEmitter } from "node:events";
import type { Message } from "@spi-code/contracts";

export function smokeMessages() {
  const messages: Message[] = [];
  const received = new EventEmitter();
  return {
    push(message: Message): void {
      messages.push(message);
      received.emit("message");
    },
    clear(): void {
      messages.length = 0;
    },
    async waitForStartedTurn(): Promise<Message> {
      const start = await this.wait((message) => message.type === "turn.start");
      const terminal = await this.waitForTurn(start.id);
      if (terminal.type === "error") {
        throw new Error(
          `Smoke turn failed (${terminal.payload.code}): ${terminal.payload.message}`,
        );
      }
      return terminal;
    },
    waitForTurn(id: string): Promise<Message> {
      return this.wait(
        (message) => message.id === id && (message.type === "turn.end" || message.type === "error"),
      );
    },
    wait(match: string | ((message: Message) => boolean)): Promise<Message> {
      const predicate =
        typeof match === "string" ? (message: Message) => message.id === match : match;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          received.off("message", check);
          reject(new Error("Timed out waiting for a host message"));
        }, 10000);
        function check() {
          const index = messages.findIndex(predicate);
          const message = messages[index];
          if (message) {
            messages.splice(index, 1);
            clearTimeout(timeout);
            received.off("message", check);
            resolve(message);
          }
        }
        received.on("message", check);
        check();
      });
    },
  };
}
