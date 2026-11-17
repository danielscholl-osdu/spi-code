// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  FocusItemSchema,
  type RepoLine,
  TodayLineSchema,
  type TodaySummary,
} from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  leaveEvidence,
  openEvidence,
  parseRoute,
  setOpenSelection,
  useOpenSelection,
} from "../../app/navigation.js";
import { installSpi } from "../../test-utils/harness.js";
import { type OpenedContent, repositoryContent, todayContent } from "./content.js";
import { OpenedBody, type OpenedBodyProps } from "./OpenedBody.js";
import recorded from "./sweep-1116.json?raw";

const previousZone = process.env.TZ;
process.env.TZ = "UTC";
vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(Date.parse("2026-11-17T01:10:00Z"));
afterAll(() => {
  vi.useRealTimers();
  if (previousZone === undefined) delete process.env.TZ;
  else process.env.TZ = previousZone;
});
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
  place: { label: "Template", destination: { kind: "engineering-system" } },
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
  expect(container.textContent).toContain(halt.cause);
  expect(container.querySelector(".opened-body-effect")?.textContent).toBe(halt.effect);
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

it("repository disposition follows core onToday and counted Can wait URLs only", () => {
  const entry: RepoLine = {
    text: "Halt issue #44",
    url: halt.primary?.url,
    sub: "",
    tag: "human-required",
    tone: "neutral",
    onToday: { id: "halt:crs-conversion", rel: "source" },
  };
  const canWait: TodaySummary["canWait"] = [
    {
      id: "pulls",
      label: "Pull requests",
      place: "engineering",
      notRead: [],
      counts: [
        {
          kind: "pr",
          label: "open",
          count: 1,
          tone: "neutral",
          names: ["storage"],
          urls: ["https://github.com/Azure/osdu-spi-storage/pull/67"],
        },
      ],
    },
  ];
  const content = (entry: RepoLine) =>
    repositoryContent({
      entry,
      lines,
      items: items.map((item) => ({ ...item, actor: undefined })),
      place,
      canWait,
    });
  expect(content(entry).subject).toEqual(halt.subject);
  expect(
    content({
      ...entry,
      url: "https://github.com/Azure/osdu-spi-crs-conversion/issues/42",
      onToday: { id: "halt:crs-conversion", rel: "companion" },
    }).subject,
  ).toEqual(halt.subject);
  const storage = content({ ...entry, url: canWait[0]?.counts[0]?.urls[0], onToday: undefined });
  expect(storage.subject).toBeNull();
  expect(storage.cause).toBe("Not on Today. Counted under Can wait.");
  const partition = content({
    ...entry,
    url: "https://github.com/Azure/osdu-spi-partition/issues/245",
    onToday: undefined,
  });
  expect(partition.subject).toBeNull();
  expect(partition.cause).toBeUndefined();
  expect(content({ ...entry, onToday: undefined }).subject).toBeNull();
  expect(content({ ...entry, onToday: { id: "missing", rel: "source" } }).cause).toBeUndefined();
});

function InlineCaller({ onRender }: { onRender(): void }) {
  const selected = useOpenSelection();
  onRender();
  return (
    <div data-selected={selected?.id}>
      <OpenedBody
        content={todayContent({ line: line("halt:"), items, place })}
        selection={{ kind: "item", id: "halt:crs-conversion" }}
        origin="today"
        onClose={() => {}}
      />
    </div>
  );
}

it("inline selection and content props settle while their caller reads the open selection", async () => {
  const bridge = installSpi();
  cleanups.push(bridge.restore);
  window.location.hash = "#today";
  let renders = 0;
  const onRender = () => {
    if (++renders > 10) throw new Error("Open selection did not settle within 10 renders");
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
  });
  await act(async () => root.render(<InlineCaller onRender={onRender} />));
  expect(container.querySelector("[data-selected]")?.getAttribute("data-selected")).toBe(
    "halt:crs-conversion",
  );
  expect(renders).toBeLessThanOrEqual(3);
});

it.each(["today", "place"] as const)(
  "%s omits only its row pill and preserves the primary keyboard target",
  async (origin) => {
    if (!halt.primary) throw new Error("The halt has a primary source");
    const { container, bridge } = await mount(halt, { origin, rowUrl: halt.primary.url });
    const urls = [...container.querySelectorAll(".opened-body-sources a")].map((a) =>
      a.getAttribute("href"),
    );
    if (origin === "today") expect(urls).not.toContain(halt.primary?.url);
    else expect(urls[0]).toBe(halt.primary?.url);
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true })),
    );
    expect(bridge.openExternal).toHaveBeenCalledExactlyOnceWith(halt.primary?.url);
  },
);

it("line~rerun keeps member pills on sub-rows and allows a whole-group source", async () => {
  const { container } = await mount(group);
  expect(container.querySelectorAll(".opened-body-sources a")).toHaveLength(0);
  const shared = {
    kind: "run",
    label: "Validation",
    url: "https://github.com/Azure/osdu-spi-stack/actions/runs/123",
  } as const;
  const sharedItems = items.map((item) =>
    line("blocker:").members.some((m) => m.ids.includes(item.id))
      ? { ...item, evidence: [...item.evidence, shared] }
      : item,
  );
  const common = await mount(todayContent({ line: line("blocker:"), items: sharedItems, place }));
  expect(
    [...common.container.querySelectorAll(".opened-body-sources a")].map((a) =>
      a.getAttribute("href"),
    ),
  ).toEqual([shared.url]);
  const member = line("blocker:").members[0];
  if (!member) throw new Error("The rerun group has a member");
  const own = await mount(todayContent({ line: line("blocker:"), member, items, place }));
  for (const pill of own.container.querySelectorAll(".opened-body-sources a")) {
    expect(pill.textContent).toContain(member.fork);
  }
  expect(own.container.querySelectorAll(".opened-body-sources a").length).toBeGreaterThan(0);
});

it("localises an instant inside the deadline reason", async () => {
  const { container } = await mount({
    ...halt,
    deadline: {
      at: "2026-11-17T08:00:00.000Z",
      reason: "Before the next upstream sync, 2026-11-17T08:00:00.000Z",
    },
  });
  expect(container.querySelector("time")?.textContent).toBe("Before the next upstream sync, 08:00");
});
