// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

/** macOS binds the window's shortcuts to ⌘; Windows binds the same letters to Ctrl. */
export function isMacPlatform(userAgent = navigator.userAgent): boolean {
  return /Mac|iPhone|iPad/.test(userAgent);
}

export function shortcutLabel(key: string, mac = isMacPlatform()): string {
  return mac ? `⌘${key.toUpperCase()}` : `Ctrl+${key.toUpperCase()}`;
}

export function ariaShortcut(key: string, mac = isMacPlatform()): string {
  return `${mac ? "Meta" : "Control"}+${key.toUpperCase()}`;
}

export function matchesShortcut(event: KeyboardEvent, key: string, mac = isMacPlatform()): boolean {
  if (event.altKey || event.shiftKey) return false;
  if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return false;
  return event.key.toLowerCase() === key.toLowerCase();
}
