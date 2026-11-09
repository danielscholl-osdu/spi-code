// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

/** The nearest ancestor a container query with this name would query, as the browser picks it. */
export function queryContainer(element: Element, name: string | undefined) {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    const [names, type] = style.getPropertyValue("container").includes("/")
      ? style.getPropertyValue("container").split("/")
      : [style.getPropertyValue("container-name"), style.getPropertyValue("container-type")];
    if (!/\b(inline-size|size)\b/.test(type ?? "")) continue;
    if (name === undefined || (names ?? "").trim().split(/\s+/).includes(name)) return node;
  }
  return null;
}

/** happy-dom skips @container rules, so this applies the stylesheet's own ones inline. */
export function applyContainerRules(sheet: CSSStyleSheet) {
  for (const rule of sheet.cssRules) {
    if (!rule.cssText.startsWith("@container")) continue;
    const { conditionText, cssRules } = rule as CSSConditionRule;
    const query = /^(?:([\w-]+)\s+)?\(max-width:\s*(\d+)px\)$/.exec(conditionText.trim());
    if (!query) throw new Error(`Unhandled container query: ${conditionText}`);
    const [, name, max] = query;
    for (const inner of cssRules) {
      const { selectorText, style } = inner as CSSStyleRule;
      for (const element of document.querySelectorAll<HTMLElement>(selectorText)) {
        const container = queryContainer(element, name);
        if (!container || container.getBoundingClientRect().width > Number(max)) continue;
        for (let index = 0; index < style.length; index++) {
          const property = style.item(index);
          element.style.setProperty(property, style.getPropertyValue(property));
        }
      }
    }
  }
}
