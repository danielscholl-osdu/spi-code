// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

// The marker holds no "[" or "{", so jsonResult never mistakes it for the start of a payload.
export const REDACTED = "<redacted>";

// Shorter *TOKEN* values (flags such as TOKENIZERS_PARALLELISM=false) are not secrets, and
// replacing them would corrupt ordinary output.
export const MIN_SECRET_LENGTH = 8;

// Consume JSON escapes as whole units, never as an optional trailing backslash.
const whitespace = String.raw`(?:\s|\\[nrtbf]|\\u00(?:09|0[acd]|20))`;
const quote = String.raw`(?:\\?["'])?`;
const authorization = new RegExp(
  String.raw`((?<![A-Za-z])authorization(?:\\?["']|\\(?=\s*[:=]))?${whitespace}*[:=]${whitespace}*${quote})(?:\\(?:u[0-9a-f]{4}|[^nr])|[^\r\n"',}\\])+`,
  "gi",
);
const bearer = new RegExp(
  String.raw`(\bbearer${whitespace}+${quote})(?:\\(?:[\\/]|u[0-9a-f]{4})|[^\s"',;}\\])+`,
  "gi",
);

export function redact(text: string, env: Record<string, string> = {}): string {
  let safe = text;
  const secrets = Object.entries(env)
    .filter(([name, value]) => /TOKEN/i.test(name) && value.length >= MIN_SECRET_LENGTH)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) safe = safe.split(secret).join(REDACTED);
  return safe
    .replace(/(?:gh[opsur]_|github_pat_|glpat-)[A-Za-z0-9_-]+/g, REDACTED)
    .replace(authorization, `$1${REDACTED}`)
    .replace(bearer, `$1${REDACTED}`);
}
