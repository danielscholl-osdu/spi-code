// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

// The marker holds no "[" or "{", so jsonResult never mistakes it for the start of a payload.
export const REDACTED = "<redacted>";

// Shorter *TOKEN* values (flags such as TOKENIZERS_PARALLELISM=false) are not secrets, and
// replacing them would corrupt ordinary output.
export const MIN_SECRET_LENGTH = 8;

// Consume JSON escapes as whole units, never as an optional trailing backslash.
const whitespace = String.raw`(?:\s|\\[nrtbf]|\\u00(?:09|0[a-d]|20))`;
const quote = String.raw`(?:\\?["'])?`;

// JSON nested in a JSON string doubles the backslashes of every escape, and some writers
// spell control characters as \u00XX. A quote escaped at any depth has an odd backslash run.
const nestedWhitespace = String.raw`(?:\s|\\+(?:[nrtbf]|u00(?:0[89a-d]|20)))`;
const nestedQuote = String.raw`(?:\\(?:\\\\)*)?["']`;
const escapedBoundary = String.raw`(?<=\\[nrtbf]|\\u00(?:0[89a-d]|20))`;

// Backslash pairs are consumed whole, except the pairs in front of an escaped quote: dropping
// them would turn a nested string's escaped quote into its terminator.
const pairs = String.raw`(?:\\\\)+(?=[^\\]|\\[^\\"']|$)`;
const authorizationUnit = String.raw`(?:${pairs}|\\(?:u[0-9a-f]{4}|[^nr"'\\])|[^\r\n"',}\\])`;
const bearerUnit = String.raw`(?:${pairs}|\\(?:\/|u[0-9a-f]{4})|[^\s"',;}\\])`;

const headers = [
  [
    String.raw`(?:(?<![A-Za-z])|(?<=\\[nrtbf]))authorization(?:\\?["']|\\(?=\s*[:=]))?${whitespace}*[:=]${whitespace}*${quote}`,
    authorizationUnit,
  ],
  [String.raw`(?:\b|(?<=\\[nrtbf]))bearer${whitespace}+${quote}`, bearerUnit],
  [
    String.raw`(?:(?<![A-Za-z])|${escapedBoundary})authorization(?:${nestedQuote}|\\(?=\s*[:=]))?${nestedWhitespace}*[:=]${nestedWhitespace}*(?:${nestedQuote})?`,
    authorizationUnit,
  ],
  [String.raw`(?:\b|${escapedBoundary})bearer${nestedWhitespace}+(?:${nestedQuote})?`, bearerUnit],
].map(([head, unit]) => ({
  head: new RegExp(`${head}(?=${unit})`, "iy"),
  value: new RegExp(`${unit}+`, "iy"),
}));

// Every header is matched from every keyword in the original text, so one match can never
// swallow the keyword that starts another. Each keyword keeps its longest introducer, so a
// chunk boundary that hides the escape before a keyword cannot fold escaped whitespace after
// the colon into the value.
function hideHeaderValues(text: string): string {
  const ranges: [number, number][] = [];
  const reached = headers.map(() => 0);
  for (const { index } of text.matchAll(/authorization|bearer/gi)) {
    let range: [number, number] | undefined;
    headers.forEach(({ head, value }, pattern) => {
      head.lastIndex = index;
      if (!head.test(text)) return;
      const start = head.lastIndex;
      // A value starting inside an earlier value of the same pattern ends where that one ends.
      if (start >= (reached[pattern] ?? 0)) {
        value.lastIndex = start;
        value.test(text);
        reached[pattern] = value.lastIndex;
      }
      const end = reached[pattern] ?? start;
      range = range ? [Math.max(range[0], start), Math.max(range[1], end)] : [start, end];
    });
    if (range) ranges.push(range);
  }
  ranges.sort(([a], [b]) => a - b);
  let safe = "";
  let at = 0;
  for (const [start, end] of ranges) {
    if (end <= at) continue;
    safe += start < at ? "" : `${text.slice(at, start)}${REDACTED}`;
    at = end;
  }
  return safe + text.slice(at);
}

export function redact(text: string, env: Record<string, string> = {}): string {
  let safe = text;
  const secrets = Object.entries(env)
    .filter(([name, value]) => /TOKEN/i.test(name) && value.length >= MIN_SECRET_LENGTH)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) safe = safe.split(secret).join(REDACTED);
  return hideHeaderValues(safe.replace(/(?:gh[opsur]_|github_pat_|glpat-)[A-Za-z0-9_-]+/g, REDACTED));
}
