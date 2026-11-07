// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

export function plainTitle(title: string): string {
  return title
    .replace(
      /[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\u200D|\uFE0F/gu,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}
