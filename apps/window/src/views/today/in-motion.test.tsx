// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import busyRaw from "../../../../../fixtures/watch/snapshot-busy.json?raw";
import calmRaw from "../../../../../fixtures/watch/snapshot-calm.json?raw";
import { RightPanel } from "../../panels/RightPanel.js";
import { createSelectionStore } from "../../panels/selection.js";
import { CAN_WAIT_ID } from "../../panels/selection-rows.js";
import { createWatchStore } from "../../store/watch.js";
import { InMotion } from "./InMotion.js";
import { CASCADE, moving as movingFrom, ROLLOUT, SYNC_PR } from "./in-motion.test-helper.js";
import Today from "./index.js";

const calm = () => ViewSnapshotSchema.parse(JSON.parse(calmRaw));
const busy = () => ViewSnapshotSchema.parse(JSON.parse(busyRaw));
const moving = () => movingFrom(busy());

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.location.hash = "#today";
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

async function mount(body: ViewSnapshot) {
  const port = { postMessage: vi.fn() };
  const selection = createSelectionStore(port);
  const store = createWatchStore(vi.fn(), selection);
  store.setState({ snapshot: { cursor: body.cursor, body } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <>
        <Today store={store} onOpenSettings={vi.fn()} onOpenEvidence={vi.fn()} />
        <InMotionProbe body={body} selection={selection} />
        <RightPanel store={selection} snapshot={body} />
      </>,
    ),
  );
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return { container, selection, port };
}

/** Today mounts In motion on the shared store; the probe draws it on the test's own store. */
function InMotionProbe({
  body,
  selection,
}: {
  body: ViewSnapshot;
  selection: ReturnType<typeof createSelectionStore>;
}) {
  return (
    <div className="probe">
      <InMotion snapshot={body} selection={selection} />
    </div>
  );
}

const texts = (root: ParentNode, selector: string) =>
  [...root.querySelectorAll(selector)].map((element) => element.textContent);
const motion = (container: Element) => container.querySelector(".probe .today-motion");
const click = async (element: Element | null | undefined) => {
  expect(element).toBeInstanceOf(HTMLElement);
  await act(async () => (element as HTMLElement).click());
};

describe("In motion and Can wait draw core's fields only", () => {
  it("draws the calm morning's In progress run and Can wait chips in Today's motion slot", async () => {
    const body = calm();
    const run = body.briefing.ambient?.inProgress;
    const canWait = body.briefing.canWait;
    if (!run || !canWait) throw new Error("calm carries no In progress run or Can wait");
    const { container } = await mount(body);
    const slot = container.querySelector('[data-today-slot="motion"] .today-motion');
    expect(slot?.querySelector(".today-motion-figure")?.textContent).toBe(`· ${run.text}`);
    expect(
      [...(slot?.querySelectorAll(".today-motion-line") ?? [])].map((li) =>
        li.getAttribute("data-line-id"),
      ),
    ).toEqual(run.lines.map(({ id }) => id));
    expect(slot?.querySelector(".today-motion-line")?.getAttribute("title")).toBe(
      run.lines[0]?.text,
    );
    expect(texts(slot ?? container, ".today-canwait-chip")).toEqual(
      canWait.chips.map(({ text }) => text),
    );
  });

  it("draws nothing on the busy morning, whose In progress run and Can wait are empty", async () => {
    const body = busy();
    expect(body.briefing.ambient?.inProgress.lines).toEqual([]);
    expect(body.briefing.canWait?.chips).toEqual([]);
    const { container } = await mount(body);
    expect(container.querySelector('[data-today-slot="motion"]')).toBeNull();
    expect(container.querySelector(".today-motion")).toBeNull();
    expect(container.textContent).not.toMatch(/In motion|Can wait/);
  });

  it("draws busy's lines exactly as core words them, without re-filtering or recounting", async () => {
    const body = moving();
    const run = body.briefing.ambient?.inProgress;
    if (!run) throw new Error("no run");
    run.text = "core's own figure";
    run.items = 99;
    const { container } = await mount(body);
    const root = motion(container);
    expect(root?.querySelector(".today-motion-figure")?.textContent).toBe("· core's own figure");
    expect(root?.querySelector(".today-motion-run")?.getAttribute("data-items")).toBe("99");
    expect(
      [...(root?.querySelectorAll(".today-motion-line") ?? [])].map((li) =>
        li.getAttribute("title"),
      ),
    ).toEqual([ROLLOUT.text, SYNC_PR.text, CASCADE.text]);
    expect(texts(root ?? container, ".today-canwait-chip")).toEqual([
      "232 upstream-owned232",
      "file",
    ]);
  });

  it("draws a waiting PR as fork, line glyph, PR badge, state chip and age, with ⇣ only on upstream origin", async () => {
    const { container } = await mount(moving());
    const root = motion(container);
    const sync = root?.querySelector('[data-line-id="ambient:gate1:workflow"]');
    expect(sync?.querySelector(".today-motion-service .kit-chip--service")?.textContent).toBe(
      "workflow",
    );
    expect(sync?.querySelector('[data-station="sync-pr"] .kit-slot--waiting')).not.toBeNull();
    expect(sync?.querySelector(".kit-slot--upstream")).not.toBeNull();
    expect(sync?.querySelector(".kit-pr")?.textContent).toBe("#59");
    expect(sync?.querySelector(".today-motion-state > .kit-chip--warn")?.textContent).toBe(
      "review",
    );
    expect(sync?.querySelector(".kit-chip--age")?.textContent).toBe("13h");
    expect(sync?.querySelector(".kit-chip--upstream")?.textContent).toBe("⇣");

    const cascade = root?.querySelector('[data-line-id="ambient:gate2:search"]');
    expect(
      cascade?.querySelector('[data-station="release-upstream-pr"] .kit-slot--waiting'),
    ).not.toBeNull();
    expect(texts(cascade ?? container, ".today-motion-state > .kit-chip")).toEqual([
      "approval",
      "⟲ after drain",
    ]);
    expect(cascade?.querySelector(".kit-chip--upstream")).toBeNull();
    expect(cascade?.querySelector(".kit-slot--upstream")).toBeNull();
  });

  it("keeps the line glyph's legend to In motion only when Failing draws no glyph", async () => {
    const body = moving();
    const { container } = await mount(body);
    expect(motion(container)?.querySelectorAll(".kit-line-legend")).toHaveLength(0);
    for (const cleanup of cleanups.splice(0)) await cleanup();
    const quiet = moving();
    if (quiet.briefing.ambient)
      quiet.briefing.ambient.failing = { items: 0, text: "0 in 0", lines: [] };
    const again = await mount(quiet);
    expect(motion(again.container)?.querySelectorAll(".kit-line-legend")).toHaveLength(1);
  });
});

describe("the rollout line", () => {
  it("shows only the next-merge chips: no progress cells and no slots", async () => {
    const { container } = await mount(moving());
    const rollout = motion(container)?.querySelector(".today-motion-rollout");
    expect(texts(rollout ?? container, ".today-motion-next .kit-chip--service")).toEqual(
      ROLLOUT.next,
    );
    expect(rollout?.querySelector(".kit-progress, .kit-cells, .kit-slot, .kit-line")).toBeNull();
    expect(rollout?.querySelector(".kit-pr")).toBeNull();
  });

  it("states core's words when no merge is ready, and draws no chip", async () => {
    const body = calm();
    const line = body.briefing.ambient?.inProgress.lines[0];
    expect(line?.next).toEqual([]);
    const { container } = await mount(body);
    const rollout = motion(container)?.querySelector(".today-motion-rollout");
    expect(rollout?.querySelector(".kit-chip--service")).toBeNull();
    expect(rollout?.querySelector(".today-motion-quiet")?.textContent).toBe(line?.text);
  });
});

describe("openers", () => {
  it("opens a line's item in Detail from its row", async () => {
    const { container, selection, port } = await mount(moving());
    await click(
      motion(container)?.querySelector('[data-line-id="ambient:gate2:search"] .today-motion-open'),
    );
    expect(selection.getState().selected).toBe("gate2:search");
    expect(port.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "inspect.request", payload: { id: "gate2:search" } }),
    );
  });

  it("opens the PR in Detail from its badge", async () => {
    const { container, selection } = await mount(moving());
    await click(
      motion(container)?.querySelector('[data-line-id="ambient:gate1:workflow"] .kit-pr'),
    );
    expect(selection.getState().selected).toBe("gate1:workflow");
  });

  it("opens the rollout item in Detail from its row", async () => {
    const { container, selection } = await mount(moving());
    await click(motion(container)?.querySelector(".today-motion-rollout .today-motion-open"));
    expect(selection.getState().selected).toBe("rollout");
  });

  it("opens a fork's place from its chip, and a next merge's place from the rollout chip", async () => {
    const { container, selection } = await mount(moving());
    await click(
      motion(container)?.querySelector(
        '[data-line-id="ambient:gate2:search"] .today-motion-service .kit-chip--service',
      ),
    );
    expect(window.location.hash).toBe("#service/search");
    await click(
      motion(container)?.querySelector(".today-motion-next .kit-chip--service:nth-child(2)"),
    );
    expect(window.location.hash).toBe("#service/crs-catalog");
    expect(selection.getState().selected).toBeNull();
  });

  it.each([0, 1])(
    "opens the Can wait list in Detail from chip %i, with each item's reason",
    async (index) => {
      const body = moving();
      const { container, selection, port } = await mount(body);
      const chips = motion(container)?.querySelectorAll(".today-canwait-chip");
      await click(chips?.[index]);
      expect(selection.getState().selected).toBe(CAN_WAIT_ID);
      expect(port.postMessage).not.toHaveBeenCalled();
      const panel = container.querySelector('aside[aria-label="Detail"]');
      expect(panel?.querySelector(".detail-title")?.textContent).toBe("Can wait");
      const fields = [...(panel?.querySelectorAll(".detail-row-fields > div") ?? [])].map((div) => [
        div.querySelector("dt")?.textContent,
        div.querySelector("dd")?.textContent,
      ]);
      expect(fields).toEqual(
        (body.briefing.canWait?.items ?? []).map(({ service, text, why }) => [
          service ?? text,
          why,
        ]),
      );
      expect(
        motion(container)?.querySelector(".today-canwait")?.hasAttribute("data-selected"),
      ).toBe(true);
    },
  );
});
