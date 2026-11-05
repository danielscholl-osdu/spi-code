// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

export const platforms = ["darwin-arm64", "win32-x64"] as const;
export type ToolPlatform = (typeof platforms)[number];
export interface ToolPin {
  tool: string;
  version: string;
  platforms: Record<ToolPlatform, { url: string; sha256: string }>;
}

export function isVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value);
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a manifest object");
  }
  return value as Record<string, unknown>;
}

export function parseManifest(value: unknown): ToolPin[] {
  const tools = object(value).tools;
  if (!Array.isArray(tools) || !tools.length) throw new Error("Manifest needs tools");
  const names = new Set<string>();
  return tools.map((value) => {
    const pin = object(value);
    if (typeof pin.tool !== "string" || !/^[a-z][a-z0-9-]*$/.test(pin.tool)) {
      throw new Error("Invalid tool name");
    }
    if (!isVersion(pin.version) || names.has(pin.tool)) throw new Error("Invalid or duplicate pin");
    names.add(pin.tool);
    const assets = object(pin.platforms);
    function asset(platform: ToolPlatform) {
      const entry = object(assets[platform]);
      if (typeof entry.url !== "string" || typeof entry.sha256 !== "string") {
        throw new Error(`Missing URL or checksum for ${platform}`);
      }
      const url = new URL(entry.url);
      if (
        !["https:", "http:", "file:"].includes(url.protocol) ||
        !/\.(?:tar\.gz|zip)$/.test(url.pathname) ||
        !/^[a-f0-9]{64}$/.test(entry.sha256)
      ) {
        throw new Error(`Invalid archive or SHA-256 for ${platform}`);
      }
      return { url: entry.url, sha256: entry.sha256 };
    }
    return {
      tool: pin.tool,
      version: pin.version,
      platforms: { "darwin-arm64": asset("darwin-arm64"), "win32-x64": asset("win32-x64") },
    };
  });
}
