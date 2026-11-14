// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Reading, ReadingSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { navigate } from "../../app/navigation.js";
import { readPins } from "../../store/pins.js";
import { Place, type PlaceProps } from "./Place.js";

type Content = NonNullable<Reading["content"]>;
type Item = Content["items"][number];

function item(id: string, scope: string, group: string, rung: Item["rung"]): Item {
  return {
    id,
    ids: [id],
    rung,
    cls: "HALT",
    scope,
    title: `Review ${id}`,
    sub: `Evidence for ${id}`,
    cause: "A filter entry changed",
    effect: "The next sync would stop",
    next: "Review the filter",
    verb: "Review",
    evidence: [],
    attention: rung === 0 ? "interrupt" : rung === 1 ? "surface" : "ambient",
    owned: group === "Owned",
    group,
    ...(group === "Before 18:00" ? { due: { at: "2026-11-06T18:00:00Z", before: "18:00" } } : {}),
  };
}

const content: Content = {
  headline: "Two forks need you before the next sync.",
  qualifier: "Upstream diffs are incomplete, so a toolchain move could be missing.",
  tiles: [
    { label: "Incoming", value: "107", counts: "commits across 10 forks" },
    { label: "Toolchain", value: "8 forks", counts: "move to os-core-common 8.5.0" },
    { label: "Largest", value: "25", counts: "commits for indexer" },
  ],
  items: [
    item("partition:halt", "partition", "Before 18:00", 1),
    item("cascade:blocked", "entitlements", "Owned", 0),
    item("legal:hold", "legal", "Before 18:00", 1),
    item("toolchain:move", "fleet", "Toolchain", 2),
    item("stack:review", "Environment", "New", 1),
  ],
  folded: "9 more, including release reviews",
};
const reading = ReadingSchema.parse({ anchor: { kind: "upstream" }, content });
const services = ["partition", "entitlements", "legal"];
const cleanups: (() => Promise<void>)[] = [];

async function mount(props: Partial<PlaceProps> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onNavigate = vi.fn();
  const render = async (overrides: Partial<PlaceProps>) =>
    act(async () =>
      root.render(
        <Place
          name="Upstream"
          reading={reading}
          services={services}
          onNavigate={onNavigate}
          {...props}
          {...overrides}
        />,
      ),
    );
  await render({});
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return { container, onNavigate, render };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  localStorage.clear();
});

const text = (container: Element, selector: string) =>
  [...container.querySelectorAll(selector)].map((element) => element.textContent);

it.each([true, false])(
  "renders the reading with qualifier=%s and exactly three named measures",
  async (qualified) => {
    const { qualifier, ...unqualified } = content;
    const { container } = await mount({
      reading: { ...reading, content: qualified ? content : unqualified },
    });
    expect(container.querySelector("h1")?.textContent).toBe("Upstream");
    expect(container.querySelector(".place-headline")?.textContent).toBe(content.headline);
    expect(container.querySelector(".place-qualifier")?.textContent).toBe(
      qualified ? qualifier : undefined,
    );
    expect(container.querySelectorAll(".place-tile")).toHaveLength(3);
    expect(text(container, ".place-tile dt")).toEqual(content.tiles.map((tile) => tile.label));
    expect(text(container, ".place-tile-value")).toEqual(content.tiles.map((tile) => tile.value));
    expect(text(container, ".place-tile-counts")).toEqual(content.tiles.map((tile) => tile.counts));
  },
);

it("renders the qualifier exactly as core words it", async () => {
  const qualifier = "Upstream cut 2 diffs short, so a toolchain move could be missing.";
  const { container } = await mount({
    reading: { ...reading, content: { ...content, qualifier } },
  });
  expect(container.querySelector(".place-qualifier")?.textContent).toBe(qualifier);
});

it("caps the whole reading at five items, preserves its groups, and ends with the folded line", async () => {
  const { container } = await mount({
    reading: {
      ...reading,
      content: {
        ...content,
        items: [
          ...content.items,
          item("hidden:one", "legal", "New", 2),
          item("hidden:two", "legal", "Hidden group", 2),
        ],
      },
    },
  });
  expect(container.querySelectorAll(".place-item")).toHaveLength(5);
  expect(text(container, ".place-group h3")).toEqual(["Before 18:00", "Owned", "Toolchain", "New"]);
  expect(text(container, ".place-group:first-child .place-item-title")).toEqual([
    "Review partition:halt",
    "Review legal:hold",
  ]);
  expect(container.textContent).not.toContain("hidden:");
  expect(container.querySelector(".place-folded")?.textContent).toBe(content.folded);
  expect(container.querySelector(".place-reading")?.lastElementChild?.className).toBe(
    "place-folded",
  );
});

it("renders no empty item groups, folded line, threads or composer", async () => {
  const { container, render } = await mount();
  expect(text(container, "h1, h2, h3")).toEqual([
    "Upstream",
    content.headline,
    "Before 18:00",
    "Owned",
    "Toolchain",
    "New",
  ]);
  expect(container.querySelectorAll("section")).toHaveLength(6);
  expect(container.querySelector("form, textarea, input, [role='textbox']")).toBeNull();
  expect(container.querySelector("[data-section='threads'], [data-section='composer']")).toBeNull();
  await render({ reading: { ...reading, content: { ...content, items: [], folded: null } } });
  expect(text(container, "h1, h2, h3")).toEqual(["Upstream", content.headline]);
  expect(container.querySelectorAll("section")).toHaveLength(2);
  expect(container.querySelector(".place-groups, .place-folded")).toBeNull();
});

it("keeps only the header when the reading has not been computed", async () => {
  const { container, render } = await mount();
  await render({ reading: { anchor: { kind: "upstream" }, content: null } });
  const place = container.querySelector(".place");
  expect(place?.children).toHaveLength(1);
  expect(place?.firstElementChild?.tagName).toBe("HEADER");
  expect(place?.textContent).toBe("Upstream");
  expect(container.querySelector(".place-reading")).toBeNull();
});

it("omits Pin without a pin and toggles the place's pin from the header", async () => {
  const { container, render } = await mount();
  expect(container.querySelector("header button")).toBeNull();
  await render({ name: "Environment", pin: "place:environment" });
  const button = container.querySelector<HTMLButtonElement>("header button");
  expect(button?.getAttribute("aria-label")).toBe("Unpin Environment");
  await act(async () => button?.click());
  expect(readPins()).not.toContain("place:environment");
  expect(button?.getAttribute("aria-label")).toBe("Pin Environment");
  await act(async () => button?.click());
  expect(readPins().at(-1)).toBe("place:environment");
  await render({ name: "Environment" });
  expect(container.querySelector("header button")).toBeNull();
});

it("renders supplied header actions beside Pin, with no action space when absent", async () => {
  const onAction = vi.fn();
  const { container, render } = await mount();
  const header = container.querySelector("header");
  expect(header?.children).toHaveLength(1);
  const actions = (
    <button type="button" onClick={() => onAction()}>
      Line view
    </button>
  );
  await render({ actions });
  expect(text(container, "header > *")).toEqual(["Upstream", "Line view"]);
  const action = header?.querySelector<HTMLButtonElement>("button");
  await act(async () => action?.click());
  expect(onAction).toHaveBeenCalledExactlyOnceWith();
  await render({ actions, pin: "legal" });
  expect(text(container, "header > *")).toEqual(["Upstream", "Line view", "Pin"]);
  await render({});
  expect(text(container, "header > *")).toEqual(["Upstream"]);
});

it("selects named, keyboard-reachable row buttons and marks only the selected item", async () => {
  const onSelect = vi.fn();
  const { container, render, onNavigate } = await mount({ onSelect });
  const buttons = [...container.querySelectorAll<HTMLButtonElement>("button[data-selection-id]")];
  expect(buttons).toHaveLength(5);
  for (const button of buttons) {
    expect(button.type).toBe("button");
    expect(button.tabIndex).toBe(0);
    expect(button.getAttribute("aria-label")).toContain("Review ");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.querySelector("button")).toBeNull();
    button.focus();
    expect(document.activeElement).toBe(button);
  }
  const target = buttons[0];
  if (!target) throw new Error("Missing selectable item");
  await act(async () => target.click());
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("partition:halt");
  expect(onNavigate).not.toHaveBeenCalled();
  await render({ selectedId: "partition:halt" });
  expect(
    container.querySelector('button[aria-pressed="true"]')?.getAttribute("data-selection-id"),
  ).toBe("partition:halt");
  expect(container.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(1);
  expect(container.querySelector(".place-item[data-selected]")?.getAttribute("data-item-id")).toBe(
    "partition:halt",
  );
  expect(container.querySelectorAll(".place-item[data-selected]")).toHaveLength(1);
  onSelect.mockClear();
  const scope = container.querySelector<HTMLButtonElement>("button.place-scope");
  await act(async () => scope?.click());
  expect(onSelect).not.toHaveBeenCalled();
  expect(onNavigate).toHaveBeenCalledExactlyOnceWith({ kind: "service", id: "partition" });
});

it("keeps item content static without onSelect, even when selectedId is supplied", async () => {
  const { container } = await mount({ selectedId: "partition:halt" });
  expect(
    container.querySelector("[data-selection-id], [aria-pressed], [data-selected]"),
  ).toBeNull();
  expect(
    [...container.querySelectorAll(".place-item-content")].map((element) => element.tagName),
  ).toEqual(["DIV", "DIV", "DIV", "DIV", "DIV"]);
});

it("renders all three measures without duplicate-key warnings when their labels match", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { container } = await mount({
      reading: {
        ...reading,
        content: {
          ...content,
          tiles: [
            { ...content.tiles[0], label: "Count" },
            { ...content.tiles[1], label: "Count" },
            { ...content.tiles[2], label: "Count" },
          ],
        },
      },
    });
    expect(text(container, ".place-tile-value")).toEqual(["107", "8 forks", "25"]);
    expect(errors.mock.calls.filter(([message]) => String(message).includes("same key"))).toEqual(
      [],
    );
  } finally {
    errors.mockRestore();
  }
});

it("ends each item with its next step and omits that part when the step is empty", async () => {
  const { container } = await mount({
    reading: {
      ...reading,
      content: {
        ...content,
        items: [
          { ...item("halt", "partition", "Before 18:00", 1), next: "Add a filter rule" },
          { ...item("hold", "legal", "Before 18:00", 1), next: "" },
        ],
      },
    },
  });
  expect(text(container, ".place-item-next")).toEqual(["Add a filter rule"]);
  expect(container.querySelector('[data-item-id="halt"]')?.textContent?.trim()).toMatch(
    /Add a filter rule$/,
  );
  expect(container.querySelector('[data-item-id="hold"] .place-item-next')).toBeNull();
});

it("renders each rank, scope, attention, due time and ownership from the contract", async () => {
  const { container } = await mount();
  const visible = [
    content.items[0],
    content.items[2],
    content.items[1],
    content.items[3],
    content.items[4],
  ];
  expect(text(container, ".place-rank")).toEqual(visible.map((row) => `P${row?.rung}`));
  expect(text(container, ".place-scope")).toEqual(visible.map((row) => row?.scope));
  expect(text(container, ".place-item-sub")).toEqual(visible.map((row) => row?.sub));
  expect(
    [...container.querySelectorAll(".place-item")].map((row) => row.getAttribute("data-attention")),
  ).toEqual(["surface", "surface", "interrupt", "ambient", "surface"]);
  expect(text(container, ".place-owned")).toEqual(["Owned"]);
  expect(text(container, ".place-item time")).toEqual(["Before 18:00", "Before 18:00"]);
  expect(
    [...container.querySelectorAll("time")].map((time) => time.getAttribute("datetime")),
  ).toEqual(["2026-11-06T18:00:00Z", "2026-11-06T18:00:00Z"]);
});

it("navigates scope chips through the navigation callback, but not aggregate scopes", async () => {
  const { container, onNavigate } = await mount();
  for (const button of container.querySelectorAll<HTMLButtonElement>("button.place-scope")) {
    await act(async () => button.click());
  }
  expect(onNavigate.mock.calls).toEqual([
    [{ kind: "service", id: "partition" }],
    [{ kind: "service", id: "legal" }],
    [{ kind: "service", id: "entitlements" }],
    [{ kind: "environment" }],
  ]);
  const fleet = container.querySelector(".place-scope[data-aggregate]");
  expect(fleet?.tagName).toBe("SPAN");
  expect(fleet?.textContent).toBe("fleet");
});

it("uses the landed navigation interface for named places and repository scopes", async () => {
  const { container } = await mount({
    onNavigate: navigate,
    reading: {
      ...reading,
      content: {
        ...content,
        items: [
          item("upstream:review", "Upstream", "New", 1),
          item("template:review", "osdu-spi", "New", 1),
          item("stack:review", "osdu-spi-stack", "New", 1),
          item("security:review", "Security", "New", 1),
        ],
      },
    },
  });
  const previous = window.location.hash;
  try {
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button.place-scope")];
    expect(buttons).toHaveLength(4);
    for (const [index, hash] of [
      "#upstream",
      "#engineering-system",
      "#environment",
      "#security",
    ].entries()) {
      await act(async () => buttons[index]?.click());
      expect(window.location.hash).toBe(hash);
    }
  } finally {
    window.location.hash = previous;
  }
});
