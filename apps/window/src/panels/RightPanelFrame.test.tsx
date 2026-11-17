// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { RightPanelFrame } from "./RightPanelFrame.js";

function Thread({ presentation }: { presentation: "inline" | "sheet" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" aria-controls="app-right-panel" onClick={() => setOpen(true)}>
        Context
      </button>
      <RightPanelFrame open={open} presentation={presentation} onClose={() => setOpen(false)}>
        <button type="button" onClick={() => setOpen(false)}>
          Close context
        </button>
      </RightPanelFrame>
    </>
  );
}

it.each(["inline", "sheet"] as const)(
  "keeps thread context keyboard access and restores its opener as %s",
  async (presentation) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Thread presentation={presentation} />));
      const opener = container.querySelector<HTMLButtonElement>("[aria-controls]");
      if (!opener) throw new Error("Missing opener");
      opener.focus();
      await act(async () => opener.click());
      const close = container.querySelector<HTMLButtonElement>("#app-right-panel button");
      if (!close) throw new Error("Missing close control");
      if (presentation === "sheet") expect(document.activeElement).toBe(close);
      close.focus();
      await act(async () =>
        close.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        ),
      );
      expect(container.querySelector("#app-right-panel")).toBeNull();
      expect(document.activeElement).toBe(opener);
      await act(async () => opener.click());
      await act(async () =>
        container.querySelector<HTMLButtonElement>("#app-right-panel button")?.click(),
      );
      expect(document.activeElement).toBe(opener);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  },
);
