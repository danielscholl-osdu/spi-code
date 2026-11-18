// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

const code = /^(?:[a-f\d]{7,40}\b|[`@]|[\p{L}\d]+(?:[./_:-][\p{L}\d]|\p{Lu}))/u;

export function sentenceHeadline(text: string): string {
  const first = /^\p{P}*(\p{Ll})\S*/u.exec(text);
  if (!first?.[1] || code.test(first[0])) return text;
  const index = first[0].indexOf(first[1]);
  return text.slice(0, index) + first[1].toUpperCase() + text.slice(index + first[1].length);
}
