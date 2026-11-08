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

/**
 * Host state words arrive in capitals ("PREPARED", "P1 · CASCADE STOPPED"); Detail shows them in
 * sentence case. Text with any lower-case letter, or only short capitals such as "PR #58", is kept.
 */
export function sentenceCase(text: string): string {
  if (/\p{Ll}/u.test(text) || !/\p{Lu}{4,}/u.test(text)) return text;
  return text
    .split(" · ")
    .map((part) => {
      let first = true;
      return part
        .split(/[ _]+/)
        .map((word) => {
          if (!/^\p{Lu}+$/u.test(word)) return word;
          const lower = word.toLowerCase();
          if (!first) return lower;
          first = false;
          return lower.charAt(0).toUpperCase() + lower.slice(1);
        })
        .join(" ");
    })
    .join(" · ");
}
