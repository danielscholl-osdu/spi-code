// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import {
  BriefingSchema,
  type InspectResult,
  InspectResultSchema,
  PROTOCOL_VERSION,
  parseMessage,
  type ReadRecord,
  type ViewSnapshot,
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
import { expectNoEvidenceMarks } from "../components/evidence/marks.test-helper.js";
import { fixtureLoader, installSpi } from "../test-utils/harness.js";
import { clockTime } from "../time.js";
import { RightPanel } from "./RightPanel.js";
import { createSelectionStore, type SelectionStore } from "./selection.js";
import { runRow, type SelectionKind, type SelectionRow, selectionRows } from "./selection-rows.js";
import { inspectFromOracle, type OracleBoard, oracleClass, oracleNext } from "./test-inspect.js";

const loadFixture = fixtureLoader((path) => readFileSync(path, "utf8"));

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

it.each(
  Object.values({
    queue: ["queue", "queue item"],
    flow: ["flow", "upstream sync"],
    plan: ["plan", "wave plan"],
    repository: ["repository", "repository"],
    "repository-line": ["repository-line", "repository line"],
    run: ["run", "run"],
    "template-step": ["template-step", "template step"],
    theme: ["theme", "theme"],
    environment: ["environment", "lane event"],
    release: ["release", "release month"],
    station: ["station", "station"],
    "can-wait": ["can-wait", "today"],
    "today-more": ["today-more", "today"],
    "release-version": ["release-version", "release"],
    "release-pr": ["release-pr", "release PR"],
    "release-notable": ["release-notable", "notable change"],
  } satisfies { [Kind in SelectionKind]: [Kind, string] }),
)("names %s in plain words", async (kind, words) => {
  const port = fakePort();
  const view = await mount(port.store);
  try {
    await act(async () =>
      port.store.getState().select("selected", { id: "selected", title: "Selected", kind }),
    );
    expect(view.container.querySelector(".inspector-kicker")?.textContent).toBe(words);
  } finally {
    await view.cleanup();
  }
});

it("selects a row-only item's Detail from Evidence and explains its empty Evidence tab", async () => {
  const port = fakePort();
  const view = await mount(port.store);
  try {
    await act(async () => port.store.getState().setTab("evidence"));
    await act(async () =>
      port.store.getState().select("station:legal:lane", {
        id: "station:legal:lane",
        title: "Stack lane",
        kind: "station",
        inspectId: null,
      }),
    );
    expect(view.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      "Detail",
    );
    expect(view.container.querySelector(".detail-title")?.textContent).toBe("Stack lane");
    await act(async () => port.store.getState().setTab("evidence"));
    expect(view.container.querySelector('[role="tabpanel"]')?.textContent).toBe(
      "No evidence for this selection.",
    );
  } finally {
    await view.cleanup();
  }
});

it.each(Object.keys(oracle))(
  "renders the %s oracle's class, cause, effect and next",
  async (cls) => {
    const result = inspectFromOracle(board(cls), `${cls.toLowerCase()}:svc`);
    expect(result.class).toBe(cls);
    expect(oracleClass(board(cls))).toBe(cls);
    const view = await inspect(result);
    try {
      expect(view.text("class")).toBe(cls);
      expect(view.text("cause")).toBe(result.cause || undefined);
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
])("takes no space for the unshipped %s action %o", async (cls, action) => {
  const view = await inspect(
    inspectFromOracle(board(cls), `${cls.toLowerCase()}:svc`, { actions: [action] }),
  );
  try {
    expect(view.text("class")).toBe(cls);
    expect(view.container.querySelector("[data-action]")).toBeNull();
    expect(view.container.textContent).not.toContain(action.label);
    expect(view.container.textContent).not.toContain(action.disabledReason);
  } finally {
    await view.cleanup();
  }
});

it("offers Detail and selection Evidence, but no run logs or threads", async () => {
  const view = await inspect(inspectFromOracle(board("HALT"), "halt:entitlements"));
  try {
    const tabs = view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect([...tabs].map((tab) => tab.textContent)).toEqual(["Detail", "Evidence"]);
    expect(view.container.textContent).not.toContain("Run logs are not available yet.");
    // Ask about this and Add to chat ship at M3, so they take no space yet.
    const labels = [...view.container.querySelectorAll("button")].map((item) => item.textContent);
    expect(labels).not.toContain("Ask");
    expect(labels).not.toContain("Add to chat");
    expect(view.container.textContent).not.toContain("Threads are not available yet.");
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

it.each(["", "   "])(
  "omits empty inspect fields %j rather than drawing placeholders",
  async (empty) => {
    const view = await inspect(
      inspectFromOracle(board("HALT"), "halt:entitlements", {
        cause: empty,
        effect: empty,
        next: empty,
        why: empty,
      }),
    );
    try {
      expect(view.container.querySelector(".inspector > dl")).toBeNull();
      expect(view.container.textContent).not.toContain("Not stated");
      for (const field of ["cause", "effect", "next", "why"])
        expect(view.text(field)).toBeUndefined();
    } finally {
      await view.cleanup();
    }
  },
);

it("opens the sweep Evidence from the title bar and switches to the selection's Detail on select", async () => {
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
    expect(selected()).toBe("Detail");
    expect(view.text("class")).toBe("HALT");
    expect(view.container.querySelector("[data-sweep-stub]")).toBeNull();
    await act(async () => port.store.getState().setTab("evidence"));
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
  const fixture = loadFixture("snapshot-mixed-59d6895.json");
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

async function mountDetail(snapshot: ViewSnapshot) {
  const port = fakePort();
  const openExternal = vi.fn(async () => true);
  const harness = installSpi({
    openExternal,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<RightPanel store={port.store} snapshot={snapshot} />));
  const select = async (row: SelectionRow) => {
    await act(async () => port.store.getState().select(row.id, row));
    expect(port.sent().payload.id).toBe(row.id);
    await port.reply(
      InspectResultSchema.parse({
        id: row.id,
        class: "SECURITY",
        cause: "Read from the sweep.",
        effect: "",
        next: "",
        why: "",
        evidence: [],
        related: [],
        approval: null,
        actions: [],
      }),
    );
  };
  const fields = () =>
    Array.from(container.querySelectorAll(".detail-row-fields > div"), (pair) => [
      pair.querySelector("dt")?.textContent,
      pair.querySelector("dd")?.textContent,
    ]);
  return {
    container,
    openExternal,
    select,
    fields,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      harness.restore();
    },
  };
}

const recordedLine = (snapshot: ViewSnapshot, prefix: string) => {
  for (const repo of snapshot.briefing.repositories.rows)
    for (const section of repo.sections)
      for (const line of section.lines) if (line.id?.startsWith(prefix)) return line;
  throw new Error(`Recorded sweep needs a ${prefix} line`);
};

it.each(["pr:", "issue:", "alert:"])(
  "shows a %s line's id and snapshot URL in Detail, selected through inspect.request",
  async (prefix) => {
    const snapshot = loadFixture("snapshot-mixed-59d6895.json");
    const line = recordedLine(snapshot, prefix);
    const row = selectionRows(snapshot).find(({ id }) => id === line.id);
    if (!row || !line.id || !line.url) throw new Error("Recorded line needs an id and a URL");
    const view = await mountDetail(snapshot);
    try {
      await view.select(row);
      expect(view.container.querySelector('[data-field="class"]')?.textContent).toBe("SECURITY");
      expect(view.container.querySelector(".inspector-kicker")?.textContent).toBe(
        "repository line",
      );
      expect(view.container.querySelector(".detail-title")?.textContent).toBe(line.text);
      expect(view.fields()).toEqual([
        ["Tag", line.tag],
        ["Reading", line.sub],
        ["Id", line.id],
        ["Link", line.url],
      ]);
      const link = view.container.querySelector<HTMLAnchorElement>(".detail-row-fields a");
      expect(link?.getAttribute("href")).toBe(line.url);
      const click = new MouseEvent("click", { bubbles: true, cancelable: true });
      await act(async () => link?.dispatchEvent(click));
      expect(click.defaultPrevented).toBe(true);
      expect(view.openExternal).toHaveBeenCalledWith(line.url);
    } finally {
      await view.cleanup();
    }
  },
);

it("leaves a repository line's missing tag, reading and link out of Detail", async () => {
  const snapshot = structuredClone(loadFixture("snapshot-mixed-59d6895.json"));
  const line = recordedLine(snapshot, "issue:");
  Object.assign(line, { tag: "", sub: "" });
  delete line.url;
  const row = selectionRows(snapshot).find(({ id }) => id === line.id);
  if (!row) throw new Error("Recorded line needs a row");
  const view = await mountDetail(snapshot);
  try {
    await view.select(row);
    expect(view.fields()).toEqual([["Id", line.id]]);
    expect(view.container.querySelector(".detail-row-fields a")).toBeNull();
    expect(view.container.querySelector(".detail-row-fields")?.textContent).not.toMatch(
      /Not stated|Tag|Reading|Link/,
    );
  } finally {
    await view.cleanup();
  }
});

it("shows a run's workflow, result and local time, with its snapshot URL", async () => {
  const snapshot = loadFixture("snapshot-mixed-59d6895.json");
  const services = snapshot.services ?? [];
  const recorded = services[0]?.runs[0];
  if (!recorded) throw new Error("Recorded sweep needs a run");
  const run = { ...recorded, time: "2026-10-13T00:15:00-05:00" };
  const view = await mountDetail(snapshot);
  try {
    await view.select(runRow(run, 0));
    expect(view.container.querySelector(".inspector-kicker")?.textContent).toBe("run");
    expect(view.container.querySelector(".detail-title")?.textContent).toBe(
      `${run.workflow} · ${run.result}`,
    );
    expect(view.fields()).toEqual([
      ["Workflow", run.workflow],
      ["Result", run.result],
      ["When", clockTime(run.time)],
      ["Link", run.url],
    ]);
    expect(view.container.querySelector(".detail-row-fields time")?.getAttribute("datetime")).toBe(
      run.time,
    );
    expect(view.container.querySelector(".detail-row-fields a")?.getAttribute("href")).toBe(
      run.url,
    );
  } finally {
    await view.cleanup();
  }
});

it("leaves a run's empty workflow or result out of Detail", async () => {
  const snapshot = loadFixture("snapshot-mixed-59d6895.json");
  const recorded = snapshot.services?.[0]?.runs[0];
  if (!recorded) throw new Error("Recorded sweep needs a run");
  const view = await mountDetail(snapshot);
  try {
    await view.select(runRow({ ...recorded, result: "" }, 0));
    expect(view.container.querySelector(".detail-title")?.textContent).toBe(recorded.workflow);
    expect(view.fields().map(([label]) => label)).toEqual(["Workflow", "When", "Link"]);
    await view.select(runRow({ ...recorded, workflow: "" }, 0));
    expect(view.container.querySelector(".detail-title")?.textContent).toBe(recorded.result);
    expect(view.fields().map(([label]) => label)).toEqual(["Result", "When", "Link"]);
    expect(view.container.querySelector(".detail-row-fields")?.textContent).not.toContain(
      "Not stated",
    );
  } finally {
    await view.cleanup();
  }
});

it.each(["", "not-an-instant"])("leaves a run's unusable time %j out of Detail", async (time) => {
  const snapshot = loadFixture("snapshot-mixed-59d6895.json");
  const recorded = snapshot.services?.[0]?.runs[0];
  if (!recorded) throw new Error("Recorded sweep needs a run");
  const view = await mountDetail(snapshot);
  try {
    await view.select(runRow({ ...recorded, time }, 0));
    expect(view.fields().map(([label]) => label)).toEqual(["Workflow", "Result", "Link"]);
    expect(view.container.querySelector(".detail-row-fields time")).toBeNull();
  } finally {
    await view.cleanup();
  }
});

it("leaves a run's empty URL out of Detail", async () => {
  const snapshot = loadFixture("snapshot-mixed-59d6895.json");
  const recorded = snapshot.services?.[0]?.runs[0];
  if (!recorded) throw new Error("Recorded sweep needs a run");
  const view = await mountDetail(snapshot);
  try {
    await view.select(runRow({ ...recorded, url: "" }, 0));
    expect(view.fields().map(([label]) => label)).toEqual(["Workflow", "Result", "When"]);
    expect(view.container.querySelector(".detail-row-fields a")).toBeNull();
  } finally {
    await view.cleanup();
  }
});
