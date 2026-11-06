// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  BriefingSchema,
  type InspectResult,
  InspectResultSchema,
  PROTOCOL_VERSION,
  parseMessage,
  type ReadRecord,
  ViewSnapshotSchema,
} from "@spi-code/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import briefing from "../../../../fixtures/rib-59d6895/oracle/briefing.json?raw";
import ACCESS from "../../../../fixtures/rib-59d6895/oracle/inspect/ACCESS.json?raw";
import BUILD from "../../../../fixtures/rib-59d6895/oracle/inspect/BUILD.json?raw";
import CONFLICT from "../../../../fixtures/rib-59d6895/oracle/inspect/CONFLICT.json?raw";
import ENV from "../../../../fixtures/rib-59d6895/oracle/inspect/ENV.json?raw";
import HALT from "../../../../fixtures/rib-59d6895/oracle/inspect/HALT.json?raw";
import INFRA from "../../../../fixtures/rib-59d6895/oracle/inspect/INFRA.json?raw";
import POLICY from "../../../../fixtures/rib-59d6895/oracle/inspect/POLICY.json?raw";
import TEST from "../../../../fixtures/rib-59d6895/oracle/inspect/TEST.json?raw";
import TOOLCHAIN from "../../../../fixtures/rib-59d6895/oracle/inspect/TOOLCHAIN.json?raw";
import UNREAD from "../../../../fixtures/rib-59d6895/oracle/inspect/UNREAD.json?raw";
import mixed from "../../../../fixtures/watch/snapshot-mixed-59d6895.json?raw";
import { expectNoEvidenceMarks } from "../components/evidence/marks.test-helper.js";
import { mixedSnapshot } from "../store/test-snapshot.js";
import { RightPanel } from "./RightPanel.js";
import { createSelectionStore, type SelectionStore } from "./selection.js";
import { inspectFromOracle, type OracleBoard, oracleClass, oracleNext } from "./test-inspect.js";

const oracle: Record<string, OracleBoard> = Object.fromEntries(
  Object.entries({
    ACCESS,
    BUILD,
    CONFLICT,
    ENV,
    HALT,
    INFRA,
    POLICY,
    TEST,
    TOOLCHAIN,
    UNREAD,
  }).map(([cls, raw]) => [cls, JSON.parse(raw) as OracleBoard]),
);
const board = (cls: string) => {
  const found = oracle[cls];
  if (!found) throw new Error(`No oracle for ${cls}`);
  return found;
};

async function mount(
  store: SelectionStore,
  sweepEvidence?: ReactNode,
  reads: readonly ReadRecord[] = [],
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(<RightPanel store={store} sweepEvidence={sweepEvidence} reads={reads} />),
  );
  return {
    container,
    text: (field: string) => container.querySelector(`[data-field="${field}"]`)?.textContent,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function fakePort() {
  const postMessage = vi.fn();
  const store = createSelectionStore({ postMessage });
  const sent = () => {
    const parsed = parseMessage(postMessage.mock.lastCall?.[0]);
    if (!parsed.ok || parsed.message.type !== "inspect.request") throw new Error("No request");
    return parsed.message;
  };
  const reply = (payload: InspectResult, id = sent().id) =>
    act(async () =>
      store.getState().receive({
        version: PROTOCOL_VERSION,
        id,
        kind: "response",
        type: "inspect.result",
        payload,
      }),
    );
  return { store, postMessage, sent, reply };
}

async function inspect(result: InspectResult) {
  const port = fakePort();
  const view = await mount(port.store);
  await act(async () => port.store.getState().select(result.id));
  await port.reply(result);
  return { ...view, ...port };
}

it.each(Object.keys(oracle))(
  "renders the %s oracle's class, cause, effect and next",
  async (cls) => {
    const result = inspectFromOracle(board(cls), `${cls.toLowerCase()}:svc`);
    expect(result.class).toBe(cls);
    expect(oracleClass(board(cls))).toBe(cls);
    const view = await inspect(result);
    try {
      expect(view.text("class")).toBe(cls);
      expect(view.text("cause")).toBe(result.cause || "Not stated");
      if (["ACCESS", "HALT", "TEST", "TOOLCHAIN"].includes(cls)) {
        expect(result.cause).not.toBe("");
      }
      expect(view.text("effect")).toBe("Nothing else waits on it.");
      expect(view.text("next")).toBe(oracleNext(board(cls)));
      expect(view.text("next")).not.toBe("");
    } finally {
      await view.cleanup();
    }
  },
);

it("keeps inferred evidence coarse in Detail without per-record inferred markers", async () => {
  const view = await inspect(
    inspectFromOracle(board("HALT"), "halt:entitlements", {
      evidence: [
        {
          source: "github",
          object: "Azure/osdu-spi-entitlements",
          observedAt: "2026-10-21T15:00:00.000Z",
          completeness: { kind: "complete" },
          inferred: true,
        },
      ],
    }),
  );
  try {
    expect(view.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      "Detail",
    );
    const records = view.container.querySelector('ul[aria-label="Evidence"]');
    if (!records) throw new Error("Missing Detail evidence list");
    expect(records.textContent).toContain("github · Azure/osdu-spi-entitlements");
    expectNoEvidenceMarks(records);
    expect(
      view.container.querySelectorAll("[data-selection-evidence][data-inferred]"),
    ).toHaveLength(1);
  } finally {
    await view.cleanup();
  }
});

it("selecting a Today item sends inspect.request with its id and renders the reply", async () => {
  const focus = BriefingSchema.parse(JSON.parse(briefing)).focus.find((f) => f.cls === "HALT");
  if (!focus) throw new Error("No HALT focus item in the briefing oracle");
  const port = fakePort();
  const view = await mount(port.store);
  try {
    expect(view.container.textContent).toContain("No selection");
    await act(async () => port.store.getState().select(focus.id));
    expect(port.postMessage).toHaveBeenCalledTimes(1);
    expect(port.sent().payload).toEqual({ id: focus.id });
    expect(view.container.querySelector('[role="status"]')?.textContent).toContain(focus.id);

    const result = inspectFromOracle(board("HALT"), focus.id);
    await port.reply({ ...result, cause: "late" }, "another-request");
    await port.reply({ ...result, id: "halt:legal" });
    expect(view.text("cause")).toBeUndefined();

    await port.reply(result);
    expect(view.text("class")).toBe("HALT");
    expect(view.text("cause")).toBe(focus.cause);
    expect(view.text("next")).toBe(focus.next);
  } finally {
    await view.cleanup();
  }
});

it("shows a host error for the selection in place", async () => {
  const port = fakePort();
  const view = await mount(port.store);
  try {
    await act(async () => port.store.getState().select("halt:entitlements"));
    await act(async () =>
      port.store.getState().receive({
        version: PROTOCOL_VERSION,
        id: port.sent().id,
        kind: "response",
        type: "error",
        payload: { code: "unsupported_message", message: "Host does not handle this message yet" },
      }),
    );
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
      "Host does not handle this message yet",
    );
  } finally {
    await view.cleanup();
  }
});

it("renders an id the sweep does not hold as a quiet empty state, not an error", async () => {
  const port = fakePort();
  const view = await mount(port.store);
  try {
    await act(async () => port.store.getState().select("repositories"));
    await act(async () =>
      port.store.getState().receive({
        version: PROTOCOL_VERSION,
        id: port.sent().id,
        kind: "response",
        type: "error",
        payload: { code: "not_found", message: "Nothing in the latest sweep has this id" },
      }),
    );
    const empty = view.container.querySelector('[role="tabpanel"] .panel-empty');
    expect(empty?.textContent).toBe("Nothing in the latest sweep has this id");
    expect(empty?.getAttribute("role")).toBeNull();
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(view.container.querySelector("aside")?.getAttribute("aria-busy")).toBe("false");

    const result = inspectFromOracle(board("HALT"), "halt:entitlements");
    await act(async () => port.store.getState().select(result.id));
    await port.reply(result);
    expect(view.container.querySelector('[role="tabpanel"] .panel-empty')).toBeNull();
    expect(view.text("cause")).toBe(result.cause);
  } finally {
    await view.cleanup();
  }
});

it("reissues an in-flight inspection on a new host and settles only the replacement request", async () => {
  const port = fakePort();
  const view = await mount(port.store);
  const hello = (pid: number) => ({
    version: PROTOCOL_VERSION,
    id: "hello",
    kind: "event",
    type: "host.hello",
    payload: { pid },
  });
  try {
    await act(async () => port.store.getState().receive(hello(123)));
    await act(async () => port.store.getState().select("halt:entitlements"));
    const oldRequest = port.sent();
    await act(async () => port.store.getState().receive(hello(123)));
    expect(port.postMessage).toHaveBeenCalledTimes(1);
    await act(async () => port.store.getState().receive(hello(456)));
    expect(port.postMessage).toHaveBeenCalledTimes(2);
    expect(port.sent().payload).toEqual(oldRequest.payload);
    expect(port.sent().id).not.toBe(oldRequest.id);
    const result = inspectFromOracle(board("HALT"), "halt:entitlements");
    await port.reply(result, oldRequest.id);
    expect(view.container.querySelector("aside")?.getAttribute("aria-busy")).toBe("true");
    await port.reply(result);
    expect(view.container.querySelector("aside")?.getAttribute("aria-busy")).toBe("false");
    expect(view.text("cause")).toBe(result.cause);
    await act(async () => port.store.getState().receive(hello(789)));
    expect(port.postMessage).toHaveBeenCalledTimes(2);
  } finally {
    await view.cleanup();
  }
});

it("settles an in-flight inspection on give-up regardless of the supervisor's request id", async () => {
  const port = fakePort();
  const view = await mount(port.store);
  try {
    await act(async () => port.store.getState().select("halt:entitlements"));
    const oldRequest = port.sent();
    const message = "Host stopped after repeated crashes. Restart SPI Code to reconnect.";
    await act(async () =>
      port.store.getState().receive({
        version: PROTOCOL_VERSION,
        id: "unrelated-supervisor-request",
        kind: "response",
        type: "error",
        payload: { code: "host_unavailable", message },
      }),
    );
    expect(view.container.querySelector("aside")?.getAttribute("aria-busy")).toBe("false");
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(message);
    await port.reply(inspectFromOracle(board("HALT"), "halt:entitlements"), oldRequest.id);
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(message);
  } finally {
    await view.cleanup();
  }
});

it("keeps a completed inspection visible when the host gives up with no request pending", async () => {
  const result = inspectFromOracle(board("HALT"), "halt:entitlements");
  const view = await inspect(result);
  try {
    const shown = view.store.getState().result;
    await act(async () =>
      view.store.getState().receive({
        version: PROTOCOL_VERSION,
        id: "host-supervisor",
        kind: "response",
        type: "error",
        payload: { code: "host_unavailable", message: "Host stopped after repeated crashes." },
      }),
    );
    expect(view.store.getState().result).toBe(shown);
    expect(view.store.getState().error).toBeNull();
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(view.container.querySelector("aside")?.getAttribute("aria-busy")).toBe("false");
    expect(view.text("cause")).toBe(result.cause);
  } finally {
    await view.cleanup();
  }
});

it.each([
  ["TEST", { id: "diagnose", label: "Diagnose", disabledReason: "Diagnose ships in M3." }],
  [
    "ENV",
    {
      id: "rerun-lanes",
      label: "Re-run when deployable",
      disabledReason: "Re-run ships in M4; the stack is not deployable now.",
    },
  ],
])("shows the %s action %o disabled with its reason in place", async (cls, action) => {
  const view = await inspect(
    inspectFromOracle(board(cls), `${cls.toLowerCase()}:svc`, { actions: [action] }),
  );
  try {
    const button = view.container.querySelector<HTMLButtonElement>(
      `[data-action="${action.id}"] button`,
    );
    expect(button?.textContent).toBe(action.label);
    expect(button?.disabled).toBe(true);
    const reason = document.getElementById(button?.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toBe(action.disabledReason);
    expect(reason?.closest("[data-action]")).toBe(button?.closest("[data-action]"));
    await act(async () => button?.click());
    expect(view.postMessage).toHaveBeenCalledTimes(1);
  } finally {
    await view.cleanup();
  }
});

it("offers Detail and selection Evidence, but no run logs or threads", async () => {
  const view = await inspect(inspectFromOracle(board("HALT"), "halt:entitlements"));
  try {
    const tabs = view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect([...tabs].map((tab) => tab.textContent)).toEqual(["Detail", "Evidence", "Log"]);
    expect(tabs[2]?.disabled).toBe(true);
    expect(view.container.textContent).toContain("Run logs are not available yet.");
    for (const label of ["Ask", "Add to chat"]) {
      const button = [...view.container.querySelectorAll<HTMLButtonElement>("button")].find(
        (item) => item.textContent === label,
      );
      expect(button?.disabled).toBe(true);
      expect(
        document.getElementById(button?.getAttribute("aria-describedby") ?? "")?.textContent,
      ).toBe("Threads are not available yet.");
    }
    await act(async () => tabs[1]?.click());
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(view.container.querySelector('[data-evidence="selection"]')).not.toBeNull();
    await act(async () =>
      tabs[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(view.text("class")).toBe("HALT");
  } finally {
    await view.cleanup();
  }
});

it("opens the sweep Evidence from the title bar and returns to the selection's Evidence on select", async () => {
  const port = fakePort();
  const view = await mount(port.store, <p data-sweep-stub="">the sweep</p>);
  try {
    const selected = () =>
      view.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
    await act(async () => port.store.getState().openSweepEvidence());
    expect(selected()).toBe("Evidence");
    expect(view.container.querySelector("[data-sweep-stub]")).not.toBeNull();
    await act(async () => port.store.getState().select("halt:entitlements"));
    await port.reply(
      inspectFromOracle(board("HALT"), "halt:entitlements", {
        evidence: [
          {
            source: "github",
            object: "Azure/osdu-spi-entitlements",
            observedAt: "2026-10-21T15:00:00.000Z",
            completeness: { kind: "complete" },
          },
        ],
      }),
    );
    expect(selected()).toBe("Evidence");
    expect(view.container.querySelector("[data-sweep-stub]")).toBeNull();
    const article = view.container.querySelector('[data-evidence="selection"]');
    expect(article?.querySelector('table[aria-label^="Reads for"]')?.textContent).toContain(
      "Azure/osdu-spi-entitlements",
    );
    await act(async () => port.store.getState().openSweepEvidence());
    expect(view.container.querySelector("[data-sweep-stub]")).not.toBeNull();
    await act(async () => view.container.querySelector<HTMLButtonElement>('[role="tab"]')?.click());
    await act(async () =>
      [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')][1]?.click(),
    );
    expect(view.container.querySelector("[data-sweep-stub]")).toBeNull();
    expect(view.container.querySelector('[data-evidence="selection"]')).not.toBeNull();
  } finally {
    await view.cleanup();
  }
});

it("keeps a host-shaped repository selection's reads from the sweep on its Evidence tab", async () => {
  const observedAt = "2026-10-12T21:58:20.000Z";
  const at = (source: string, object: string, more: Partial<ReadRecord> = {}): ReadRecord => ({
    source,
    object,
    observedAt,
    completeness: { kind: "complete" },
    ...more,
  });
  const fixture = mixedSnapshot(mixed);
  const snapshot = ViewSnapshotSchema.parse({
    ...fixture,
    reads: [
      ...fixture.reads,
      at("github", "Azure/osdu-spi-partition"),
      at("Azure/osdu-spi-partition", "security", { failure: "http_403" }),
      at("Azure/osdu-spi-partition", "fork-runs"),
      at("github", "repos/Azure/osdu-spi-partition/check-runs/12/annotations"),
      at("osdu/platform/system/partition", "merged MRs"),
      at("github", "Azure/osdu-spi-indexer-queue"),
      at("Azure/osdu-spi-partition-extra", "security"),
    ],
  });
  const result = InspectResultSchema.parse({
    id: "repo:partition",
    title: "partition",
    class: "SECURITY",
    cause: "partition",
    effect: "",
    next: "",
    why: "",
    evidence: [],
    related: [],
    approval: null,
    actions: [],
    areas: snapshot.areas,
    provenance: [],
  });
  const port = fakePort();
  const view = await mount(port.store, <p data-sweep-stub="">the sweep</p>, snapshot.reads);
  try {
    await act(async () => port.store.getState().select(result.id));
    await port.reply(result);
    await act(async () => port.store.getState().setTab("evidence"));
    const article = view.container.querySelector('[data-evidence="selection"]');
    expect(article?.querySelector('table[aria-label="Areas"]')).toBeNull();
    expect(article?.textContent).toContain("does not name the areas it is drawn from");
    expect(
      [...(article?.querySelectorAll('table[aria-label="Reads for partition"] th') ?? [])].map(
        (row) => row.textContent,
      ),
    ).toEqual([
      "GitHub issues and PRs · Azure/osdu-spi-partition",
      "Azure/osdu-spi-partition · security",
      "Azure/osdu-spi-partition · fork-runs",
      "GitHub issues and PRs · repos/Azure/osdu-spi-partition/check-runs/12/annotations",
    ]);
    expect(article?.textContent).not.toContain("No reads recorded");
  } finally {
    await view.cleanup();
  }
});
