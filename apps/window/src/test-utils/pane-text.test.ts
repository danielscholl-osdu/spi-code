// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it } from "vitest";
import { paneText } from "./pane-text.test-helper.js";

it.each(["b", "strong", "em", "span", "a", "code", "small", "button"])(
  "detects missing word separators across inline %s markup",
  (tag) => {
    for (const container of ["p", "div", "span"]) {
      const dom = new DOMParser().parseFromString(
        `<${container}>Read <${tag}>the</${tag}> notes.</${container}>`,
        "text/html",
      );
      const paragraph = dom.querySelector(container);
      expect(paneText(paragraph)).toBe("Read the notes.");
      if (!paragraph) throw new Error("Missing paragraph");
      paragraph.innerHTML = `Read <${tag}>the</${tag}>notes.`;
      expect(paneText(paragraph)).toBe("Read thenotes.");
      paragraph.innerHTML = `Read<${tag}>the</${tag}> notes.`;
      expect(paneText(paragraph)).toBe("Readthe notes.");
    }
  },
);
