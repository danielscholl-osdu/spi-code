// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { act } from "react";
import { expect, it, vi } from "vitest";
import { readFixture } from "../../../../scripts/watch-generated.mjs";
import { selectionStore } from "../panels/selection.js";
import { watchStore } from "../store/watch.js";
import { fixtureLoader, type InspectionName } from "../test-utils/harness.js";
import { WATCH_INSPECTIONS, WATCH_SNAPSHOTS } from "../test-utils/watch-fixtures.test-helper.js";
import { plainTitle } from "../text.js";
import { clockTime } from "../time.js";
import {
  assertRules,
  container,
  emoji,
  open,
  shellHooks,
  todayLabelled,
  violations,
} from "./text-rules.test-helper.js";

const sweepSchedule = {
  sweepMs: 300_000,
  gitlabMs: 1_800_000,
  securityMs: 1_800_000,
  releasesMs: 3_600_000,
};

const loadFixture = fixtureLoader(readFixture);
const snapshots = WATCH_SNAPSHOTS.map((name) => ({ name, body: loadFixture(name) }));
const inspections = WATCH_INSPECTIONS.flatMap((name) => loadFixture(name as InspectionName));

shellHooks();

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
  const panel = container.querySelector(".right-panel");
  expect(panel, result.id).not.toBeNull();
  if (panel) assertRules(`Recorded Evidence ${result.id}`, panel);
});

it("reads the Sweep budget reset and the sweep line as local clock times with ISO attributes", async () => {
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
      [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] .settings-nav button')]
        .find((button) => button.textContent === "Sweep")
        ?.click(),
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
    assertRules("Sweep with a budget reset");
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

it.each([false, true])("cleans Today decision text with a token: %s", async (withToken) => {
  const body = structuredClone(snapshots.find(({ name }) => name === "snapshot-1106.json")?.body);
  const group = body?.briefing.decisions?.groups.find(({ text }) =>
    text.includes("Release PR #89"),
  );
  if (!body || !group) throw new Error("Missing recorded release decision");
  group.text += " › ⇣ ✕ ! ◐ ○ ⌀";
  group.token = withToken ? "📊 Code Coverage" : undefined;
  await open(body);
  const row = [...container.querySelectorAll(".today-decision")].find(
    (element) => element.getAttribute("data-decision-id") === group.id,
  );
  const cause = row?.querySelector(".today-decision-cause");
  const text = "Release PR #89 fails Code Coverage › ⇣ ✕ ! ◐ ○ ⌀";
  expect(row?.getAttribute("title")).toBe(text);
  expect(cause?.getAttribute("aria-label")).toBe(text);
  expect(cause?.textContent).toBe(withToken ? "Code Coverage" : text);
  assertRules("Today decision with recorded job emoji");
});

const GLYPHS = "› ⇣ ✕ ! ◐ ○ ⌀ ⏸ ⇡";
const PROSE = new Set([
  ...["headline", "summary", "title", "sub", "cause", "effect", "next", "text", "line", "lines"],
  ...["caveat", "note", "detail", "reason", "readyLine", "stateText", "followUp", "token"],
]);

/** Every prose string under `value` wrapped in job emoji, with the navigation glyphs after it. */
function withEmoji<T>(value: T, key = ""): T {
  if (typeof value === "string" && PROSE.has(key)) return `🚨 ${value} 📊 ${GLYPHS}` as T;
  if (Array.isArray(value)) return value.map((entry) => withEmoji(entry, key)) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, entry]) => [name, withEmoji(entry, name)]),
  ) as T;
}

it.each(snapshots.filter(({ name }) => name.startsWith("snapshot-1106")))(
  "cleans job emoji from Today's titles and aria-labels on $name, keeping the navigation glyphs",
  async ({ body }) => {
    const dressed = structuredClone(body);
    dressed.briefing = withEmoji(dressed.briefing);
    dressed.releases = withEmoji(dressed.releases);
    await open(dressed);
    const labels = [...container.querySelectorAll(todayLabelled)].flatMap((element) =>
      ["title", "aria-label"].map((name) => element.getAttribute(name) ?? ""),
    );
    expect(labels.filter((label) => emoji.test(label))).toEqual([]);
    const marked = labels.filter((label) => label.includes("⇡"));
    expect(marked.length).toBeGreaterThan(0);
    expect(marked.filter((label) => !label.includes(GLYPHS))).toEqual([]);
  },
);

it("shows an emoji-only decision token as the cleaned decision text", async () => {
  const body = structuredClone(snapshots.find(({ name }) => name === "snapshot-1106.json")?.body);
  const group = body?.briefing.decisions?.groups[0];
  if (!body || !group) throw new Error("Missing a decision");
  group.token = "📊";
  await open(body);
  const cause = container.querySelector(
    `.today-decision[data-decision-id="${group.id}"] .today-decision-cause`,
  );
  expect(cause?.textContent).toBe(plainTitle(group.text));
  expect(cause?.textContent).not.toBe("");
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
  ["emoji", '<p class="place-item-sub">🚨 Check the build</p>'],
  ["emoji", '<button class="today-need-title">📊 Code Coverage failed</button>'],
  ["emoji", '<button class="today-decision-cause">📊 Code Coverage failed</button>'],
  ["emoji", '<button class="horizon-token">🔧 Fix the build</button>'],
  ["emoji", '<span class="today-place-reason">🚨 Release blocked</span>'],
  ["emoji", '<li class="today-release-notable"><button>🔧 Fix the build</button></li>'],
  ["emoji", '<span class="today-motion-text">🔧 Fix the build</span>'],
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

it("keeps bound time units while collapsing ordinary title whitespace", () => {
  expect(plainTitle("  Held\t 9\u00a0d 16\u00a0h \n")).toBe("Held 9\u00a0d 16\u00a0h");
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
  const text = "© ™ ✔ › ⇣ ✕ ! ◐ ○ ⌀ ⌘";
  expect(plainTitle(text)).toBe(text);
  container.innerHTML = `<dd data-field="cause">${text}</dd>`;
  expect(violations(container)).toEqual([]);
});
