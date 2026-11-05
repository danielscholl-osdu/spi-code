// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

export type Appearance = "system" | "light" | "dark";
export function createAppearance(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = localStorage,
  media: {
    readonly matches: boolean;
    addEventListener(type: "change", listener: () => void): void;
    removeEventListener(type: "change", listener: () => void): void;
  } = matchMedia("(prefers-color-scheme: dark)"),
  target: HTMLElement = document.documentElement,
) {
  const saved = storage.getItem("spi-code.appearance");
  let pin: Appearance = saved === "light" || saved === "dark" ? saved : "system";
  const apply = () => {
    const theme = pin === "system" ? (media.matches ? "dark" : "light") : pin;
    target.dataset.theme = theme;
    target.style.colorScheme = theme;
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
