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
