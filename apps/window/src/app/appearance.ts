// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { applyPalette, readPalette } from "./palette-choice.js";

export type Appearance = "system" | "light" | "dark";
export type Theme = "light" | "dark";
export function createAppearance(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = localStorage,
  media: {
    readonly matches: boolean;
    addEventListener(type: "change", listener: () => void): void;
    removeEventListener(type: "change", listener: () => void): void;
  } = matchMedia("(prefers-color-scheme: dark)"),
  target: HTMLElement = document.documentElement,
  onTheme: (theme: Theme) => void = () => {},
) {
  applyPalette(readPalette(storage), target);
  const saved = storage.getItem("spi-code.appearance");
  let pin: Appearance = saved === "light" || saved === "dark" ? saved : "system";
  let shown: Theme | undefined;
  const apply = () => {
    const theme: Theme = pin === "system" ? (media.matches ? "dark" : "light") : pin;
    target.dataset.theme = theme;
    target.style.colorScheme = theme;
    if (theme === shown) return;
    shown = theme;
    onTheme(theme);
  };
  media.addEventListener("change", apply);
  apply();
  return {
    get pin() {
      return pin;
    },
    setPin(value: Appearance) {
      if (value === "system") storage.removeItem("spi-code.appearance");
      else storage.setItem("spi-code.appearance", value);
      pin = value;
      apply();
    },
    dispose() {
      media.removeEventListener("change", apply);
    },
  };
}
