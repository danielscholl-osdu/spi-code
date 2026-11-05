// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

export function paneText(element: Element | null): string | undefined {
  if (!element) return undefined;
  const copy = element.cloneNode(true) as Element;
  // Separate layout blocks, but preserve spaces (or their absence) within inline prose.
  for (const block of copy.querySelectorAll(
    "div,p,h2,h3,section,table,tr,td,th,li,dt,dd,ul,dl,ol,button[data-rel],button[data-theme-sel],.repo-head small,.rhead small,.theme-sub,.release-summary,.trow .ss,.pane-fact strong",
  )) {
    block.prepend(" ");
    block.append(" ");
  }
  return copy.textContent?.replace(/\s+/g, " ").trim();
}
