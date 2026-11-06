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

const ALPHANUMERIC = /[\p{L}\p{N}]/u;
const LOWERCASE = /\p{Ll}/u;
const UPPERCASE = /\p{Lu}/u;
const DIGIT = /\p{N}/u;
const COMBINING_MARKS = /\p{M}/gu;
const SYMBOL = /\p{So}/u;
const APOSTROPHE = /['’]/;
// Quotes around a pasted query: "legal sync".
const WRAPPING_QUOTES = /^\s*["'`“”‘’]+|["'`“”‘’]+\s*$/g;

const WHOLE_NAME = 1;
const WHOLE_WORD = 0.9;
const WORD_PREFIX = 0.75;
const INSIDE_WORD = 0.3;
const KEYWORD_WEIGHT = 0.6;

function foldCharacter(character: string): string {
  return character
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[‘’]/, "'");
}

/** Case and accents folded one UTF-16 unit at a time, so offsets still read from the source. */
function foldInPlace(text: string): string {
  return text
    .replace(/[\u0080-\uffff]/g, (character) => {
      const folded = foldCharacter(character);
      return folded.length === 1 ? folded : character;
    })
    .toLowerCase();
}

/** After a non-letter, at a camelCase or digit boundary, but not after a possessive apostrophe. */
function isWordStart(beforePrevious: string, previous: string, character: string, next: string) {
  const afterApostrophe = APOSTROPHE.test(previous) && ALPHANUMERIC.test(beforePrevious);
  return (
    (ALPHANUMERIC.test(character) || SYMBOL.test(character)) &&
    !afterApostrophe &&
    (previous === "" ||
      !ALPHANUMERIC.test(previous) ||
      (LOWERCASE.test(previous) && UPPERCASE.test(character)) ||
      (UPPERCASE.test(previous) && UPPERCASE.test(character) && LOWERCASE.test(next)) ||
      DIGIT.test(previous) !== DIGIT.test(character))
  );
}

type SearchField = { readonly text: string; readonly wordStarts: Uint8Array };

function foldSearchField(source: string): SearchField {
  const wordStarts = new Uint8Array(source.length);
  const characters = Array.from(source);
  let index = 0;
  for (const [position, character] of characters.entries()) {
    const previous = characters[position - 1] ?? "";
    if (
      isWordStart(
        characters[position - 2] ?? "",
        previous,
        character,
        characters[position + 1] ?? "",
      )
    )
      wordStarts[index] = 1;
    index += character.length;
  }
  return { text: foldInPlace(source), wordStarts };
}

/** Folded, whitespace-collapsed query; empty when there is nothing to match. */
export function foldSearchQuery(query: string): string {
  return foldInPlace(query.replace(WRAPPING_QUOTES, "").normalize("NFC"))
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

function tokenQuality(field: SearchField, token: string): number {
  if (field.text === token) return WHOLE_NAME;
  let best = 0;
  for (let at = field.text.indexOf(token); at >= 0; at = field.text.indexOf(token, at + 1)) {
    if (field.wordStarts[at] !== 1) {
      best = Math.max(best, INSIDE_WORD);
      continue;
    }
    const end = at + token.length;
    const wholeWord = end === field.text.length || !ALPHANUMERIC.test(field.text[end] ?? "");
    best = Math.max(best, wholeWord ? WHOLE_WORD : WORD_PREFIX);
  }
  return best;
}

export type SearchTermsMatch = { readonly score: number; readonly quality: number };

/**
 * Every query word must match a term. The first term is the name; the rest are keywords and count
 * less, so a hidden term cannot lift a row above one whose name matches.
 */
export function scoreSearchTerms(
  normalizedQuery: string,
  terms: ReadonlyArray<string>,
): SearchTermsMatch | null {
  if (normalizedQuery.length === 0) return { score: 0, quality: 0 };
  const fields = terms.map(foldSearchField);
  const tokens = normalizedQuery.split(" ");
  let quality = Number.POSITIVE_INFINITY;
  let score = 0;
  for (const token of tokens) {
    let best = 0;
    for (const [index, field] of fields.entries())
      best = Math.max(best, tokenQuality(field, token) * (index === 0 ? 1 : KEYWORD_WEIGHT));
    if (best === 0) return null;
    quality = Math.min(quality, best);
    score += best;
  }
  const name = fields[0];
  if (name && tokens.length > 1 && name.text.includes(normalizedQuery)) score += 1;
  return { score, quality };
}

// Whole words and prefixes share a class so a longer name is not pushed below a shorter one.
function matchClass(quality: number): number {
  return quality >= WHOLE_NAME ? 3 : quality >= 0.7 ? 2 : quality >= 0.4 ? 1 : 0;
}

/** Ranks each group's matches, then the groups by their best match class, keeping group order on ties. */
export function rankSearchGroups<G, T>(
  groups: ReadonlyArray<{ readonly group: G; readonly items: ReadonlyArray<T> }>,
  score: (item: T) => SearchTermsMatch | null,
): Array<{ readonly group: G; readonly items: ReadonlyArray<T> }> {
  return groups
    .flatMap(({ group, items }, order) => {
      const ranked = items.flatMap((item) => {
        const match = score(item);
        return match ? [{ item, match }] : [];
      });
      if (ranked.length === 0) return [];
      ranked.sort(
        (left, right) =>
          matchClass(right.match.quality) - matchClass(left.match.quality) ||
          right.match.score - left.match.score,
      );
      const best = Math.max(...ranked.map(({ match }) => matchClass(match.quality)));
      return [{ group, items: ranked.map(({ item }) => item), best, order }];
    })
    .sort((left, right) => right.best - left.best || left.order - right.order)
    .map(({ group, items }) => ({ group, items }));
}
