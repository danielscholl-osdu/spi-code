// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { JsonValue, ThreadEngine } from "@spi-code/threads";
import { CHIP_BYTE_BUDGET, type ChipOutcome } from "./chip.js";
import { redactSpiValue, type SpiRedactor } from "./redaction.js";

/** A chip id naming the thread whose last answer a child thread carries. */
export const FINDING_PREFIX = "finding:";

type Threads = Pick<ThreadEngine<unknown>, "read" | "eventsSince">;
type Chip = { readonly [key: string]: JsonValue };

const refuse = (reason: string): ChipOutcome => ({ ok: false, reason });
const bytes = (chip: Chip) => Buffer.byteLength(JSON.stringify(chip));

/** A thread's last completed answer as the journal holds it, cut to the chip budget. */
export function packFinding(threads: Threads, id: string, redactor: SpiRedactor): ChipOutcome {
  const threadId = id.slice(FINDING_PREFIX.length);
  let timeline: ReturnType<Threads["read"]>;
  try {
    timeline = threads.read(threadId);
  } catch {
    return refuse("The thread this continues is not known.");
  }
  const turn = [...timeline.turns]
    .reverse()
    .find(({ outcome, text }) => outcome === "completed" && text.trim());
  const finished = turn
    ? threads
        .eventsSince(threadId, 0)
        .find((event) => event.type === "turn.finished" && event.turnId === turn.id)
    : undefined;
  if (!turn || !finished) return refuse("The thread has no finished answer to carry.");
  try {
    const whole = redactSpiValue(
      {
        id,
        kind: "finding",
        thread: threadId,
        title: timeline.thread.title ?? "Untitled thread",
        scope: timeline.thread.scope,
        sweptAt: new Date(finished.at).toISOString(),
        finding: turn.text.trim(),
      },
      redactor,
    ) as Chip;
    const sweptAt = whole.sweptAt;
    const text = whole.finding;
    if (whole.id !== id || typeof sweptAt !== "string" || typeof text !== "string")
      return refuse("Context chip withheld.");
    let chip = whole;
    let trimmed = false;
    if (bytes(chip) > CHIP_BYTE_BUDGET) {
      trimmed = true;
      const note = `Over ${CHIP_BYTE_BUDGET} UTF-8 bytes, so the finding is cut. The thread ${threadId} holds the whole answer.`;
      const points = Array.from(text);
      const cut = (length: number): Chip => ({
        ...whole,
        finding: `${points.slice(0, length).join("")}…`,
        trimmed: note,
      });
      let low = 0;
      let high = points.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (bytes(cut(middle)) <= CHIP_BYTE_BUDGET) low = middle;
        else high = middle - 1;
      }
      if (low === 0)
        return refuse(`The finding for ${threadId} is over ${CHIP_BYTE_BUDGET} UTF-8 bytes.`);
      chip = cut(low);
    }
    const content = JSON.stringify(chip);
    return {
      ok: true,
      chip: { id, sweptAt, trimmed, bytes: Buffer.byteLength(content), chip, content },
    };
  } catch {
    return refuse("Context chip withheld.");
  }
}
