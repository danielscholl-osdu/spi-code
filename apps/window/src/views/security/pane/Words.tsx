// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SecurityWords } from "@spi-code/contracts";

/** Draws a line of core's words; a count an unread list could change carries ≥. */
export function Words({ words }: { words: SecurityWords }) {
  return words.map((part, index) =>
    typeof part === "string" ? (
      part
    ) : "code" in part ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: a line's parts never reorder.
      <code key={index}>{part.code}</code>
    ) : part.atLeast ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: a line's parts never reorder.
      <span key={index} data-at-least>
        ≥{part.n}
      </span>
    ) : (
      String(part.n)
    ),
  );
}

/** The words as plain text, for a tooltip or an accessible name. */
export const wordsText = (words: SecurityWords) =>
  words
    .map((part) =>
      typeof part === "string"
        ? part
        : "code" in part
          ? part.code
          : `${part.atLeast ? "≥" : ""}${part.n}`,
    )
    .join("");
