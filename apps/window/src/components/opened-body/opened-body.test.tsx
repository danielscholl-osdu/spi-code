// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { FocusItemSchema, TodayLineSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { leaveEvidence, openEvidence, parseRoute, setOpenSelection } from "../../app/navigation.js";
import { installSpi } from "../../test-utils/harness.js";
import { type OpenedContent, repositoryContent, todayContent } from "./content.js";
import { OpenedBody, type OpenedBodyProps } from "./OpenedBody.js";
import recorded from "./sweep-1116.json?raw";

const fixture = JSON.parse(recorded);

const lines = TodayLineSchema.array().parse(fixture.lines);
const items = FocusItemSchema.array().parse(fixture.items);
const place = { label: "Line › crs-conversion › Sync PR", destination: { kind: "line" } } as const;
const line = (part: string) => {
  const found = lines.find(({ id }) => id.includes(part));
  if (!found) throw new Error(`Missing fixture line ${part}`);
  return found;
};
const halt = todayContent({ line: line("halt:"), items, place });
const group = todayContent({ line: line("blocker:"), items, place });
const upgrade = line("upgrade:");
const upgradeMember = upgrade.members[0];
if (!upgradeMember) throw new Error("The upgrade has a member");
const twoSteps = todayContent({ line: upgrade, member: upgradeMember, items, place });
const source = {
  kind: "run",
  label: "Validation",
  url: "https://github.com/Azure/osdu-spi-legal/actions/runs/42",
} as const;
const cell: OpenedContent = {
  title: "legal · Cascade",
  place,
  subject: null,
  cause: "Not on Today. SPI Code has no item for this and did not read the run.",
  primary: source,
  notRead: ["The run behind this station"],
};
const run: OpenedContent = {
  title: "Smoke · fresh cluster",
  place: { label: "Environment", destination: { kind: "environment" } },
  subject: null,
  cause: "A smoke run on a fresh cluster failed. The running environment stayed ready.",
  primary: source,
};
const repository: OpenedContent = {
  title: "Review the sync filter",
  place: { label: "Engineering system", destination: { kind: "engineering-system" } },
  subject: null,
  cause: "Not on Today. Counted under Can wait.",
  primary: {
    kind: "issue",
    label: "Issue #45",
    url: "https://github.com/Azure/osdu-spi-legal/issues/45",
  },
};

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  setOpenSelection(null);
  window.location.hash = "";
});

async function mount(content: OpenedContent, props: Partial<OpenedBodyProps> = {}) {
  const bridge = installSpi();
  cleanups.push(bridge.restore);
  window.location.hash = "#today";
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onClose = vi.fn();
  await act(async () =>
    root.render(
      <OpenedBody
        content={content}
        origin="place"
        selection={{ kind: "cell", id: "legal:main" }}
        onClose={onClose}
        {...props}
      />,
    ),
  );
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return { container, bridge: bridge.spi, onClose };
}

it("a single member uses core's primary and the item's manual step when core has no ordered steps", async () => {
  const { container } = await mount(halt, { origin: "today" });
  expect(container.querySelector(".opened-body-step")?.textContent).toContain(
    ".github/upstream-filter.yml",
  );
  expect(container.querySelector(".opened-body-sources a")?.getAttribute("href")).toBe(
    halt.primary?.url,
  );
  expect(container.querySelector("time")?.dateTime).toBe(line("halt:").deadline?.at);
});

it("a group keeps core's shared steps and deduplicates the members' evidence gaps", async () => {
  const { container } = await mount(group, { origin: "today" });
  expect([...container.querySelectorAll("li")].map((node) => node.textContent)).toEqual(
    line("blocker:").steps,
  );
  expect(group.subject).toEqual({ kind: "line", id: line("blocker:").id });
  expect(group.notRead).toEqual([
    ...new Set(line("blocker:").members.flatMap((member) => member.evidence.notRead)),
  ]);
});

it("a two-step member keeps the upgrade before the review and both items' sources", async () => {
  const { container } = await mount(twoSteps);
  expect([...container.querySelectorAll("li")].map((node) => node.textContent)).toEqual(
    upgrade.members[0]?.steps,
  );
  const expected = items
    .filter((item) => upgrade.members[0]?.ids.includes(item.id))
    .flatMap((item) => item.evidence.map((link) => link.url));
  const actual = [...container.querySelectorAll(".opened-body-sources a")].map((node) =>
    node.getAttribute("href"),
  );
  for (const url of expected) expect(actual).toContain(url);
});

it("hides a cause that restates the headline and an effect that says nothing waits", async () => {
  const { container } = await mount({
    ...twoSteps,
    title: "storage PR #83 fails Validation Summary",
    cause: "PR #83 fails Validation Summary.",
    effect: "Nothing else waits on it.",
  });
  expect([...container.querySelectorAll("p")].map((p) => p.textContent)).not.toContain(
    "PR #83 fails Validation Summary.",
  );
  expect(container.querySelector(".opened-body-effect")).toBeNull();
});

it.each([
  ["non-member cell", cell],
  ["environment run", run],
  ["repository line not on Today", repository],
] as const)("%s has its own source without claiming Today membership", async (_kind, content) => {
  const { container, bridge } = await mount(content);
  expect(container.querySelector('[href="#today"]')).toBeNull();
  await act(async () =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", metaKey: true, cancelable: true }),
    ),
  );
  expect(bridge.openExternal).toHaveBeenCalledExactlyOnceWith(content.primary?.url);
});

it("omits secondary sources already on the Today row, retaining the primary first", async () => {
  const other = halt.links?.find((link) => link.url !== halt.primary?.url);
  if (!other) throw new Error("The halt has a secondary source");
  const { container } = await mount(
    { ...halt, links: [...(halt.links ?? []), other] },
    { origin: "today", rowUrl: other.url },
  );
  expect(
    [...container.querySelectorAll(".opened-body-sources a")].map((node) =>
      node.getAttribute("href"),
    ),
  ).toEqual([halt.primary?.url]);
});

it("no source action exists without a usable URL or a shipped operation", async () => {
  for (const content of [
    halt,
    group,
    twoSteps,
    cell,
    run,
    repository,
    {
      ...halt,
      primary: { label: "Queue all lanes", url: "" },
      links: [
        { label: "Ask Copilot", url: "javascript:alert(1)" },
        { label: "unknown", url: "https://example.com/run" },
      ],
    },
  ]) {
    const { container } = await mount(content);
    // M4 owns operations. Any button here is an unshipped action, including disabled buttons.
    expect(container.querySelectorAll("button, [role=button]")).toHaveLength(0);
    for (const action of container.querySelectorAll(".opened-body-sources a")) {
      expect(action.getAttribute("href")).toMatch(
        /^https:\/\/(github.com|community.opengroup.org)\//,
      );
    }
  }
});

it("Esc closes, and a missing primary gives the keyboard no source to invent", async () => {
  const { bridge, onClose } = await mount({ ...cell, primary: { label: "unknown", url: "" } });
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", metaKey: true, cancelable: true }),
    );
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
  });
  expect(bridge.openExternal).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
});

it("Evidence and the Swept capsule use the body's subject, keeping the place selection for Back", async () => {
  const { container } = await mount(group);
  await act(async () =>
    (container.querySelector(".opened-body-evidence") as HTMLAnchorElement).click(),
  );
  const route = parseRoute(window.location.hash);
  expect(route).toMatchObject({
    kind: "evidence",
    selection: group.subject,
    open: { kind: "cell", id: "legal:main" },
    about: group.subject,
  });
  if (route?.kind !== "evidence") throw new Error("Evidence route missing");
  leaveEvidence(route);
  openEvidence();
  expect(parseRoute(window.location.hash)).toMatchObject({
    kind: "evidence",
    selection: group.subject,
  });
});

it("repository sources resolve to Today only when an operator item and a core member prove it", () => {
  const entry = {
    text: "Halt issue #44",
    url: halt.primary?.url,
    sub: "",
    tag: "human-required",
    tone: "neutral",
  } as const;
  const matched = repositoryContent({ entry, lines, items, place });
  expect(matched.subject).toEqual(halt.subject);
  const unknown = repositoryContent({
    entry,
    lines,
    items: items.map((item) => ({ ...item, actor: undefined })),
    place,
  });
  expect(unknown.subject).toBeNull();
  expect(unknown.cause).toBe("Not on Today. Counted under Can wait.");
});
