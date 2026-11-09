// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { InspectResultSchema, type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectionStore } from "../panels/selection.js";
import { runRow, type SelectionKind, selectionRows } from "../panels/selection-rows.js";
import { watchStore } from "../store/watch.js";
import { plainTitle } from "../text.js";
import { clockTime } from "../time.js";
import { closeSheet, navigate, type Route, relaunch } from "./navigation.js";
import { Shell } from "./Shell.js";

const sweepSchedule = {
  sweepMs: 300_000,
  gitlabMs: 1_800_000,
  securityMs: 1_800_000,
  releasesMs: 3_600_000,
};

const directory = `${resolve("fixtures/watch")}/`;
const files = readdirSync(directory).filter((file) => file.endsWith(".json"));
const snapshots = files
  .filter((file) => file.startsWith("snapshot-"))
  .map((name) => ({
    name,
    body: ViewSnapshotSchema.parse(JSON.parse(readFileSync(`${directory}${name}`, "utf8"))),
  }));
const inspections = files
  .filter((file) => file.startsWith("inspect-"))
  .flatMap((file) =>
    InspectResultSchema.array().parse(JSON.parse(readFileSync(`${directory}${file}`, "utf8"))),
  );
const internal = /\bfork_upstream\b|\bgate\s+\d+\b|\bpresses\b|\bcut\b/i;
const machineTime = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\bUTC\b/;
const placeholder = /not available yet|No settled threads yet|ships in M[3-9]/i;
const headlines = '.place-headline, [data-pointer$="/headline"], .release-months td:nth-child(3)';
const titles =
  ".place-item-title, .place-item-sub, .place-item-next, .template-line-text, .template-line-sub, .env-repo-line-text, .env-repo-line small, .env-muted, .template-repo-title, .service-row-title, .service-section-count, .service-row-sub, .detail-title, [data-field], .inspector-related dd, .palette-label, .inbox-row-title, .inbox-sub, .today-folded li button[data-selection-id], .today-folded li p";

function violations(scope: ParentNode): string[] {
  const failures: string[] = [];
  const outsideDetail = (element: Element) =>
    !element.closest(".right-panel, [data-evidence], .section-evidence");
  for (const element of scope.querySelectorAll("*")) {
    const text = [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent)
      .join(" ");
    const copy = [text, element.getAttribute("aria-label"), element.getAttribute("title")]
      .filter(Boolean)
      .join(" ");
    if (outsideDetail(element) && (internal.test(copy) || /^(flight|quiet)$/i.test(text.trim())))
      failures.push(`internal: ${copy}`);
    if (placeholder.test(copy)) failures.push(`placeholder: ${copy}`);
    if (/\bNot stated\b/i.test(copy)) failures.push(`unstated: ${copy}`);
    if (machineTime.test(copy)) failures.push(`time: ${copy}`);
    if (element.matches("time") && Number.isNaN(Date.parse(element.getAttribute("datetime") ?? "")))
      failures.push(`time: ${element.outerHTML}`);
    if (element.matches("button") && /Open in inspector\s*·/i.test(element.textContent ?? ""))
      failures.push(`action: ${element.textContent}`);
    if (
      element.matches("h1,h2,h3,h4,ul,ol,dl") &&
      !element.textContent?.trim() &&
      !element.closest("svg")
    )
      failures.push(`empty: ${element.outerHTML}`);
  }
  for (const element of scope.querySelectorAll(headlines)) {
    const text = element.textContent?.trim() ?? "";
    if (text.split(/\s+/).length > 12) failures.push(`headline: ${text}`);
  }
  for (const element of scope.querySelectorAll(titles)) {
    if (
      /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|\u20E3/u.test(
        element.textContent ?? "",
      )
    )
      failures.push(`emoji: ${element.textContent}`);
  }
  return failures;
}

const previous = watchStore.getState();
const previousSpi = window.spi;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  closeSheet();
  relaunch();
  selectionStore.getState().clear();
  selectionStore.getState().setTab("detail");
  window.location.hash = "#today";
  window.spi = {
    proof: false,
    postMessage: vi.fn(),
    openExternal: vi.fn(),
    onMessage: () => () => {},
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  selectionStore.getState().clear();
  watchStore.setState(previous, true);
  window.spi = previousSpi;
  closeSheet();
  relaunch();
  vi.unstubAllGlobals();
});

async function open(body: ViewSnapshot, route: Route = { kind: "today" }) {
  await act(async () => root.render(null));
  await act(async () => {
    watchStore.setState({ snapshot: { cursor: body.cursor, body }, setup: null });
    navigate(route);
    root.render(<Shell />);
  });
}

function assertRules(label: string) {
  expect(violations(document.body), label).toEqual([]);
}

describe.each(snapshots)("window text rules on $name", ({ body }) => {
  it("renders Today, strip, sidebar, Line, every place, service and release month", async () => {
    const routes: Route[] = [
      { kind: "today" },
      { kind: "upstream" },
      { kind: "environment" },
      { kind: "engineering-system" },
      { kind: "releases" },
      { kind: "security" },
      ...body.stations.map(({ service }): Route => ({ kind: "service", id: service })),
      ...body.releases.lines.map(({ month }): Route => ({ kind: "release", month })),
    ];
    for (const route of routes) {
      await open(body, route);
      expect.soft(violations(document.body), JSON.stringify(route)).toEqual([]);
    }
    await act(async () => navigate({ kind: "line" }));
    expect(container.querySelector('[aria-label="Line"]')).not.toBeNull();
    assertRules("Line sheet");
    await act(async () => container.querySelector<HTMLButtonElement>(".find-or-ask")?.click());
    expect(document.querySelector('[role="dialog"][aria-label="Find or ask"]')).not.toBeNull();
    assertRules("Cmd-K");
  });

  it("renders Detail for every selection kind, omitting absent fields", async () => {
    await open(body);
    const rows = [
      ...selectionRows(body),
      ...(body.services ?? []).flatMap((service, index) =>
        service.runs.map((run) => runRow(run, index)),
      ),
      { id: "step:recorded", title: "Template revision", kind: "template-step" as const },
    ];
    const kinds = new Set<SelectionKind>();
    for (const row of rows) {
      const result = inspections.find(({ id }) => id === (row.inspectId ?? row.id));
      await act(async () => {
        selectionStore.getState().select(row.id, row);
        selectionStore.setState({
          result: result ?? {
            id: row.inspectId ?? row.id,
            class: "READY",
            cause: "",
            effect: "",
            next: "",
            why: "",
            evidence: [],
            related: [],
            approval: null,
            actions: [],
          },
          request: null,
        });
      });
      expect(container.querySelector(".detail-title"), row.id).not.toBeNull();
      kinds.add(row.kind);
      assertRules(`Detail ${row.kind}: ${row.id}`);
    }
    expect([...kinds].sort()).toEqual(
      [
        "queue",
        "flow",
        "plan",
        "repository",
        "repository-line",
        "template-step",
        "theme",
        "environment",
        "release",
        "station",
        ...((body.services ?? []).some((service) => service.runs.length > 0) ? ["run"] : []),
      ].sort(),
    );
  });
});

it.each(["flight", "planning", "quiet"] as const)(
  "names the %s state and draws no empty plan or next part",
  async (mode) => {
    const body = structuredClone(snapshots[0]?.body);
    if (!body) throw new Error("Missing snapshot");
    body.briefing.flow.mode = mode;
    body.briefing.flow.plan = { title: "", lines: [], note: "", button: "" };
    body.briefing.flow.next = { title: "", text: "", button: "", quiet: true };
    await open(body, { kind: "environment" });
    expect(container.querySelector('[data-pointer="/briefing/flow/mode"]')?.textContent).toBe(
      { flight: "Syncs in progress", planning: "Planning upstream syncs", quiet: "Nothing queued" }[
        mode
      ],
    );
    expect(container.querySelector('[data-pointer="/briefing/flow/plan"]')).toBeNull();
    expect(container.querySelector('[data-pointer="/briefing/flow/next"]')).toBeNull();
    assertRules(`Empty ${mode} plan`);
  },
);

it("labels an incomplete sweep without exposing its internal state name", async () => {
  const body = structuredClone(snapshots[0]?.body);
  if (!body) throw new Error("Missing snapshot");
  const area = body.areas[0];
  if (!area) throw new Error("Missing source");
  area.envelope = {
    source: area.area,
    state: "incomplete",
    observedAt: body.sweptAt,
    completeness: { kind: "cut", read: 1, total: 3, reason: "page_limit" },
  };
  await open(body);
  expect(container.querySelector("[data-sweep-line]")?.textContent).toContain("1 incomplete");
  assertRules("Incomplete sweep");
});

it("opens the upstream plan without presenting preparation as the button's action", async () => {
  const body = snapshots[0]?.body;
  if (!body) throw new Error("Missing snapshot");
  await open(body, { kind: "environment" });
  const button = container.querySelector<HTMLButtonElement>(
    '[data-pointer="/briefing/flow/next"] button',
  );
  expect(button?.textContent?.trim()).toBe("View upstream plan");
  await act(async () => button?.click());
  expect(selectionStore.getState().selected).toBe(body.briefing.flow.inspect);
});

it.each(inspections)("renders the recorded Detail and Evidence for $id", async (result) => {
  const body = snapshots[0]?.body;
  if (!body) throw new Error("Missing snapshot");
  await open(body);
  await act(async () => {
    selectionStore.getState().select(result.id);
    selectionStore.setState({ result, request: null });
  });
  assertRules(`Recorded Detail ${result.id}`);
  await act(async () => selectionStore.getState().setTab("evidence"));
  assertRules(`Recorded Evidence ${result.id}`);
});

it("reads Setup's budget reset and the sweep line as local clock times with ISO attributes", async () => {
  const body = snapshots[0]?.body;
  if (!body) throw new Error("Missing snapshot");
  // 23:50 in Chicago, so the reset falls on the next local day there.
  const now = Date.parse("2026-11-08T05:50:00Z");
  const resetAt = new Date(now + 32 * 60_000).toISOString();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  try {
    await open(body);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-sidebar-row="settings"]')?.click(),
    );
    await act(async () =>
      watchStore.setState({
        sweep: {
          remaining: 5,
          floor: 10,
          resetAt,
          deferredAreas: [],
          nextSweepAt: null,
          schedule: sweepSchedule,
          lastSweep: null,
        },
      }),
    );
    const reset = [...document.querySelectorAll('[role="dialog"] time')].find(
      (time) => time instanceof HTMLTimeElement && time.dateTime === resetAt,
    );
    expect(reset?.textContent).toBe(clockTime(resetAt, { now }));
    expect(reset?.textContent).toMatch(/^(\d\d-\d\d )?\d\d:\d\d \(in 32\u00a0min\)$/);
    expect(clockTime(resetAt, { now, timeZone: "America/Chicago" })).toBe(
      "11-08 00:22 (in 32\u00a0min)",
    );
    expect(container.querySelector(".sweep-line time")?.getAttribute("datetime")).toBe(
      body.sweptAt,
    );
    assertRules("Setup with a budget reset");
  } finally {
    vi.useRealTimers();
  }
});

it("strips emoji from every Detail field without removing ordinary symbols", async () => {
  const body = snapshots[0]?.body;
  const recorded = inspections[0];
  if (!body || !recorded) throw new Error("Missing snapshot or inspection");
  await open(body);
  const result = {
    ...recorded,
    cause: "📊 Code Coverage failed ©",
    effect: "🚨 Release blocked ™",
    next: "🔧 Fix the check ✔",
    why: "👩🏽‍💻 Keep the release safe",
  };
  await act(async () => {
    selectionStore.getState().select(result.id);
    selectionStore.setState({ result, request: null });
  });
  for (const [field, text] of Object.entries({
    cause: "Code Coverage failed ©",
    effect: "Release blocked ™",
    next: "Fix the check ✔",
    why: "Keep the release safe",
  })) {
    expect(container.querySelector(`[data-field="${field}"]`)?.textContent).toBe(text);
  }
  assertRules("Detail fields with emoji");
});

it("omits Detail fields and their list when they contain only emoji", async () => {
  const body = snapshots[0]?.body;
  const recorded = inspections[0];
  if (!body || !recorded) throw new Error("Missing snapshot or inspection");
  await open(body);
  const result = {
    ...recorded,
    cause: "📊",
    effect: "🚨",
    next: "🔧",
    why: "👩🏽‍💻",
    related: [],
  };
  await act(async () => {
    selectionStore.getState().select(result.id);
    selectionStore.setState({ result, request: null });
  });
  expect(container.querySelector(".inspector dl")).toBeNull();
  assertRules("Emoji-only Detail fields");
});

it("omits a Related entry whose text is only emoji, and Related when none is left", async () => {
  const body = snapshots[0]?.body;
  const recorded = inspections[0];
  if (!body || !recorded) throw new Error("Missing snapshot or inspection");
  await open(body);
  const result = {
    ...recorded,
    related: [
      { text: "📥", state: "Upstream" },
      { text: "#32 📥 Upstream Sync Ready for Review", state: "Sync" },
      { text: "🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} 🔄", state: "Cascade" },
    ],
  };
  await act(async () => {
    selectionStore.getState().select(result.id);
    selectionStore.setState({ result, request: null });
  });
  const rows = [...(container.querySelector('dl[aria-label="Related"]')?.children ?? [])];
  expect(rows.map((row) => [row.querySelector("dt")?.textContent, row.textContent])).toEqual([
    ["Sync", "Sync#32 Upstream Sync Ready for Review"],
  ]);
  assertRules("Related with an emoji-only entry");
  await act(async () => {
    selectionStore.setState({
      result: { ...result, related: [{ text: "📥", state: "Upstream" }] },
      request: null,
    });
  });
  expect(container.querySelector('[aria-label="Related"]')).toBeNull();
  expect(
    [...container.querySelectorAll(".inspector h3")].map((heading) => heading.textContent),
  ).not.toContain("Related");
  assertRules("Related with only emoji entries");
});

it("strips injected emoji from a folded Today item subline", async () => {
  const body = structuredClone(snapshots[0]?.body);
  const item = body?.briefing.rest[0];
  if (!body || !item) throw new Error("Missing folded item");
  item.sub = "🚨 Review the queued change";
  await open(body);
  expect(
    container.querySelector(`.today-folded button[data-selection-id="${item.id}"] + p`)
      ?.textContent,
  ).toBe("Review the queued change");
  assertRules("Today item subline with emoji");
});

it("strips injected emoji from the template queue row", async () => {
  const body = structuredClone(snapshots[0]?.body);
  const item =
    body && [...body.briefing.focus, ...body.briefing.rest].find(({ id }) => id === "rollout");
  if (!body || !item) throw new Error("Missing rollout");
  item.title = "🐛 Refresh the template";
  item.sub = "🚨 Review queued changes";
  await open(body, { kind: "engineering-system" });
  expect(container.querySelector(".inbox-row-title")?.textContent).toBe("Refresh the template");
  expect(container.querySelector(".inbox-sub")?.textContent).toBe("Review queued changes");
  assertRules("Template queue row with emoji");
});

it("strips injected emoji from an environment repository line", async () => {
  const body = structuredClone(snapshots[0]?.body);
  const repository = body?.briefing.repositories.rows.find(({ name }) => name === "osdu-spi-stack");
  const line = repository?.sections.flatMap(({ lines }) => lines)[0];
  if (!body || !line) throw new Error("Missing stack repository line");
  line.text = "🐛 Fix the stack";
  line.sub = "🚨 Check the build";
  await open(body, { kind: "environment" });
  expect(container.querySelector(".env-repo-line-text")?.textContent).toBe("Fix the stack");
  expect(container.querySelector(".env-repo-line small")?.textContent).toBe("Check the build");
  assertRules("Environment repository line with emoji");
});

it.each([
  ["internal", "fork_upstream stopped"],
  ["headline", "One two three four five six seven eight nine ten eleven twelve thirteen"],
  ["placeholder", "Run logs are not available yet."],
  ["unstated", "Not stated"],
])("rejects a rendered %s source mutation", async (kind, text) => {
  const body = structuredClone(snapshots[0]?.body);
  if (!body) throw new Error("Missing snapshot");
  body.briefing.flow.headline = text;
  await open(body, { kind: "environment" });
  expect(violations(container).some((failure) => failure.startsWith(`${kind}:`))).toBe(true);
});

it.each([
  ["empty", "<section><h3></h3><dl></dl></section>"],
  ["emoji", '<span class="template-line-text">🐛 Fix the issue</span>'],
  ["emoji", '<dd data-field="cause">📊 Code Coverage failed</dd>'],
  ["emoji", '<details class="today-folded"><ul><li><p>🚨 Check the build</p></li></ul></details>'],
  ["action", "<button>Open in inspector · Investigate, then Dispatch cascade</button>"],
  ["time", "<p>swept 2026-11-06T14:02:00Z</p>"],
  ["time", "<p>at 2026-10-12 21:58 UTC</p>"],
  ["time", "<p>swept <time>14:02</time></p>"],
  ["time", '<p>swept <time datetime="soon">14:02</time></p>'],
])("rejects a %s rule mutation", (kind, html) => {
  container.innerHTML = html;
  expect(violations(container).some((failure) => failure.startsWith(`${kind}:`))).toBe(true);
});

it("allows internal names only in Detail or Evidence, never placeholders", () => {
  container.innerHTML =
    '<aside class="right-panel"><p>fork_upstream gate 3 presses cut</p></aside><section data-evidence><p>cut</p></section>';
  expect(violations(container)).toEqual([]);
  container.querySelector("aside")?.append("Not stated");
  expect(violations(container)).toEqual([expect.stringContaining("unstated:")]);
});

it("strips joined emoji, modifiers, flags and keycaps without losing issue numbers", () => {
  expect(plainTitle("👩🏽‍💻 🇺🇸 1️⃣ 🔧 Fix #42 build · PR #7")).toBe("Fix #42 build · PR #7");
  expect(plainTitle("Open (📊 Code Coverage) [🔧 build 🔧]")).toBe("Open (Code Coverage) [build]");
  expect(plainTitle("🏳️‍🌈 ⚙️ Fix #42")).toBe("Fix #42");
});

it("removes subdivision flags whole, with their tag characters", () => {
  const england = "🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
  const scotland = "🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}";
  const wales = "🏴\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}";
  for (const flag of [england, scotland, wales]) {
    expect(plainTitle(`${flag} Fix #42`)).toBe("Fix #42");
    expect(plainTitle(`Fix ${flag} #42 ${flag}`)).toBe("Fix #42");
  }
  expect(plainTitle(`${england}${scotland}${wales}`)).toBe("");
  expect(plainTitle(`${england} Fix`)).not.toMatch(/[\u{E0000}-\u{E007F}]/u);
});

it("keeps text-style pictographs without U+FE0F and strips them as emoji with it", () => {
  const text = "\u26A0 \u2764 \u2600 \u2714 Check the build";
  expect(plainTitle(text)).toBe(text);
  container.innerHTML = `<dd data-field="cause">${text}</dd>`;
  expect(violations(container)).toEqual([]);
  expect(plainTitle("\u26A0\uFE0F \u2764\uFE0F \u2600\uFE0F \u2714\uFE0F Check the build")).toBe(
    "Check the build",
  );
});

it("preserves ordinary symbols and the strip and command glyphs", () => {
  const text = "© ™ ✔ ✕ ! ◐ ○ ⌘";
  expect(plainTitle(text)).toBe(text);
  container.innerHTML = `<dd data-field="cause">${text}</dd>`;
  expect(violations(container)).toEqual([]);
});
