// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

export function plainTitle(title: string): string {
  return title
    .replace(
      /[0-9#*]\uFE0F?\u20E3|(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F)[\uFE0E\uFE0F]?(?:\p{Emoji_Modifier}|[\u{E0020}-\u{E007E}]+\u{E007F})?(?:\u200D\p{Extended_Pictographic}[\uFE0E\uFE0F]?\p{Emoji_Modifier}?)*/gu,
      "",
    )
    .replace(/\s+/g, " ")
    .replace(/(\(|\[)\s+/g, "$1")
    .replace(/\s+(\)|\])/g, "$1")
    .trim();
}

/** The host's all-caps state words: board statuses, fork phases and GitHub run and check states. */
const STATE_WORDS: ReadonlySet<string> = new Set([
  "UNREAD",
  "CURRENT",
  "BEHIND UPSTREAM",
  "SYNC HALTS",
  "PREPARING",
  "PREPARED",
  "CASCADE OWED",
  "IN CASCADE",
  "CASCADE STOPPED",
  "SYNC TO MAIN",
  "MAIN RUN",
  "MAIN RED",
  "ON MAIN",
  "UPSTREAM PLAN",
  "UPSTREAM PLAN PAUSED",
  "SNAPSHOT",
  "CLOSED",
  "HALT",
  "TOOLCHAIN",
  "NO BREAK",
  "MOVED",
  "PROGRAM",
  "FORK",
  "SUCCESS",
  "FAILURE",
  "ERROR",
  "PENDING",
  "EXPECTED",
  "INACTIVE",
  "QUEUED",
  "IN PROGRESS",
  "COMPLETED",
  "CANCELLED",
  "TIMED OUT",
  "SKIPPED",
  "NEUTRAL",
  "STALE",
  "ACTION REQUIRED",
  "STARTUP FAILURE",
]);

/**
 * Detail shows the host's all-caps state words in sentence case ("PREPARED" reads "Prepared").
 * Each " · " part is matched whole against the state vocabulary, so acronyms such as "SPI CI",
 * "PR #58" or "OSDU SPI" and every other part keep their spelling.
 */
export function sentenceCase(text: string): string {
  return text
    .split(" · ")
    .map((part) => {
      const words = part.replace(/_/g, " ");
      if (!STATE_WORDS.has(words)) return part;
      const lower = words.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" · ");
}
