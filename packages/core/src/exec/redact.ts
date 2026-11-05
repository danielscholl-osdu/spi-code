// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

// The marker holds no "[" or "{", so jsonResult never mistakes it for the start of a payload.
export const REDACTED = "<redacted>";

// Shorter *TOKEN* values (flags such as TOKENIZERS_PARALLELISM=false) are not secrets, and
// replacing them would corrupt ordinary output.
export const MIN_SECRET_LENGTH = 8;

export function redact(text: string, env: Record<string, string> = {}): string {
  let safe = text;
  const secrets = Object.entries(env)
    .filter(([name, value]) => /TOKEN/i.test(name) && value.length >= MIN_SECRET_LENGTH)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) safe = safe.split(secret).join(REDACTED);
  return safe
    .replace(/(?:gh[opsur]_|github_pat_|glpat-)[A-Za-z0-9_-]+/g, REDACTED)
    .replace(
      /((?<![A-Za-z])authorization\\?["']?\s*[:=]\s*\\?["']?)(?:[^\r\n"',}\\]+)/gi,
      `$1${REDACTED}`,
    )
    .replace(/(\bbearer\s+)[^\s"',;}\\]+/gi, `$1${REDACTED}`);
}
