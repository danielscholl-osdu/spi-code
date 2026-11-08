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

/** True while an IME is composing, or when the key lands in a field that takes typing. */
export function isTypingEvent(event: KeyboardEvent): boolean {
  if (event.isComposing || event.keyCode === 229) return true;
  const target = event.target;
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return (
    target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !==
    null
  );
}

export function matchesShortcut(event: KeyboardEvent, key: string, mac = isMacPlatform()): boolean {
  if (event.altKey || event.shiftKey) return false;
  if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return false;
  return event.key.toLowerCase() === key.toLowerCase();
}
