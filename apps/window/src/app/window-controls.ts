// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { isMacPlatform } from "./shortcuts.js";

/**
 * Where the desktop shell draws the native window controls in the title bar:
 * macOS insets its traffic lights on the left, Windows overlays its caption
 * buttons on the right, and a plain browser draws none.
 */
export type WindowControls = "inset" | "overlay" | "none";

export function windowControls(userAgent = navigator.userAgent): WindowControls {
  if (!/\bElectron\//.test(userAgent)) return "none";
  return isMacPlatform(userAgent) ? "inset" : "overlay";
}
