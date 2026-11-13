// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type InspectResult, InspectResultSchema, PROTOCOL_VERSION } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import recorded from "../../../../fixtures/watch/inspect-1106.json?raw";

const previousZone = process.env.TZ;
let unmount: (() => Promise<void>) | undefined;

afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (previousZone === undefined) delete process.env.TZ;
  else process.env.TZ = previousZone;
});

const hold = InspectResultSchema.array()
  .parse(JSON.parse(recorded))
  .find(({ id }) => id.startsWith("hold:"));

/** The 6 Nov station answers packages/host/src/inspect/instants.test.ts pins, on the hold's sweep. */
const station = (id: string, related: InspectResult["related"]): InspectResult =>
  InspectResultSchema.parse({
    id,
    title: id,
    class: "READY",
    cause: "",
    effect: "",
    next: "",
    why: "",
    evidence: [],
    related,
    approval: null,
    actions: [],
    areas: hold?.areas ?? [],
    provenance: [],
  });
const main = station("station:partition:main", [
  {
    text: "Validation · success · 2026-11-05T14:35:22.000Z",
    state: "Main run",
    url: "https://github.com/Azure/osdu-spi-partition/actions/runs/42046459911",
  },
]);
const lane = station("station:partition:lane", [
  {
    text: "main · 830596b57d3813811de01000590aafabb4434c9f",
    state: "SUCCESS · 2026-11-05T14:44:20.000Z",
  },
]);

async function drawn(result: InspectResult) {
  process.env.TZ = "America/Chicago";
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-06T14:02:00Z"));
  const [{ RightPanel }, { createSelectionStore }] = await Promise.all([
    import("./RightPanel.js"),
    import("./selection.js"),
  ]);
  const store = createSelectionStore({ postMessage: vi.fn() });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  await act(async () => root.render(<RightPanel store={store} />));
  await act(async () => store.getState().select(result.id));
  await act(async () =>
    store.getState().receive({
      version: PROTOCOL_VERSION,
      id: store.getState().request ?? "",
      kind: "response",
      type: "inspect.result",
      payload: result,
    }),
  );
  return container;
}

const datetimes = (scope: Element | null | undefined) =>
  [...(scope?.querySelectorAll("time") ?? [])].map((t) => t.getAttribute("dateTime"));

it("reads a recorded hold's why as Chicago clock times", async () => {
  if (!hold) throw new Error("inspect-1106.json answers a hold");
  expect(hold.why).toBe("2026-11-06T04:07:05.000Z to 2026-11-06T04:20:16.000Z");
  const why = (await drawn(hold)).querySelector('[data-field="why"]');
  expect(why?.textContent).toBe("11-05 22:07 to 11-05 22:20");
  expect(datetimes(why)).toEqual(["2026-11-06T04:07:05.000Z", "2026-11-06T04:20:16.000Z"]);
});

it("reads a station's Related run and its state as Chicago clock times", async () => {
  const run = (await drawn(main)).querySelector(".inspector-related div");
  expect(run?.querySelector("dt")?.textContent).toBe("Main run");
  expect(run?.querySelector("dd")?.textContent).toBe("Validation · success · 11-05 08:35");
  expect(datetimes(run)).toEqual(["2026-11-05T14:35:22.000Z"]);
  await unmount?.();
  const state = (await drawn(lane)).querySelector(".inspector-related dt");
  expect(state?.textContent).toBe("Success · 11-05 08:44");
  expect(datetimes(state)).toEqual(["2026-11-05T14:44:20.000Z"]);
});
