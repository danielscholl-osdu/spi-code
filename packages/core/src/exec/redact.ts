// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

export function redact(text: string, env: Record<string, string> = {}): string {
  let safe = text;
  const secrets = Object.entries(env)
    .filter(([name, value]) => /TOKEN/i.test(name) && value.length > 0)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) safe = safe.split(secret).join("[REDACTED]");
  return safe
    .replace(/(?:gh[ops]_|github_pat_|glpat-)[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/(\bauthorization["']?\s*[:=]\s*["']?)(?:[^\r\n"',}]+)/gi, "$1[REDACTED]")
    .replace(/(\bbearer\s+)[^\s"',;}]+/gi, "$1[REDACTED]");
}
