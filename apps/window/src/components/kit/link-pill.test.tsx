// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import type { Link } from "@spi-code/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { installSpi } from "../../test-utils/harness.js";
import { OCTICONS } from "../icons/Octicon.js";
import { LinkPill } from "./LinkPill.js";

const cleanups: (() => Promise<void> | void)[] = [];

async function mount(content: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(content));
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return container;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const css = readFileSync("apps/window/src/components/kit/kit.css", "utf8");
const colourOf = (pill: Element) => {
  const tone = [...pill.classList].find((name) => name.startsWith("kit-link--"));
  return css.match(new RegExp(`\\.${tone}\\s*\\{\\s*color: var\\((--[a-z-]+)\\)`))?.[1];
};

const GH = "https://github.com/Azure/osdu-spi-entitlements";
const GL = "https://community.opengroup.org/osdu/platform/security-and-compliance/entitlements";

it.each([
  ["pr", "PR #83", `${GH}/pull/83`, "pullRequest", "--accent-text", "PR #83"],
  ["pr", "PR", `${GH}/pull/83`, "pullRequest", "--accent-text", "PR"],
  ["issue", "issue #121", `${GH}/issues/121`, "issueOpened", "--work", "Issue #121"],
  ["mr", "!968", `${GL}/-/merge_requests/968`, "pullRequest", "--upstream-text", "MR !968"],
  ["commit", "main 7d269b5", `${GH}/commit/7d269b5`, "gitCommit", "--text-muted", "Commit 7d269b5"],
  ["commit", "run", `${GL}/-/commit/f9643b16`, "gitCommit", "--text-muted", "Commit"],
  [
    "compare",
    "forks on 5398e93",
    `${GH}/compare/a...b`,
    "gitCommit",
    "--text-muted",
    "Template change",
  ],
  ["run", "run Sync Upstream", `${GH}/actions/runs/1`, "play", "--text-muted", "Sync Upstream run"],
  ["run", "run", `${GH}/actions/runs/1`, "play", "--text-muted", "Run"],
  ["job", "check Setup Maven", `${GH}/actions/runs/1/job/2`, "play", "--text-muted", "Failed job"],
  ["run", "run Sync Template", `${GH}/actions/runs/2`, "play", "--text-muted", "Sync Template run"],
  ["deploy", "deployments", `${GH}/deployments`, "play", "--text-muted", "Deployments"],
] as const)(
  "a %s link labelled %j draws its icon, colour and words",
  async (kind, label, url, icon, token, text) => {
    const container = await mount(<LinkPill link={{ kind, label, url }} />);
    const pill = container.querySelector("a.kit-link");
    expect(pill?.getAttribute("data-kind")).toBe(kind);
    expect(pill?.querySelector("path")?.getAttribute("d")).toBe(OCTICONS[icon]);
    expect(colourOf(pill as Element)).toBe(token);
    expect(pill?.textContent).toBe(`${text}↗`);
    expect(pill?.querySelector(".kit-link-out")?.getAttribute("aria-hidden")).toBe("true");
  },
);

it.each<Link>([
  {
    kind: "other",
    label: "upstream-filter.yml",
    url: `${GH}/blob/main/.github/upstream-filter.yml`,
  },
  { label: "upstream-filter.yml", url: `${GH}/pull/83` },
])("a link of kind other, or with no kind, is grey with core's label and no icon", async (link) => {
  const container = await mount(<LinkPill link={link} />);
  const pill = container.querySelector("a.kit-link");
  expect(pill?.getAttribute("data-kind")).toBe("other");
  expect(pill?.querySelector("svg")).toBeNull();
  expect(colourOf(pill as Element)).toBe("--text-muted");
  expect(pill?.textContent).toBe("upstream-filter.yml↗");
});

it("a place's own words replace the kind and number", async () => {
  const container = await mount(
    <LinkPill
      link={{ kind: "commit", label: "main 7d269b5", url: `${GH}/commit/7d269b5` }}
      label="commit 7d269b5"
    />,
  );
  expect(container.querySelector("a.kit-link")?.textContent).toBe("commit 7d269b5↗");
});

it("takes an accessible name only when the place gives one", async () => {
  const link = {
    kind: "other",
    label: "CodeQL #80",
    url: `${GH}/security/code-scanning/80`,
  } as const;
  const named = await mount(<LinkPill link={link} accessibleName="CodeQL #80 in entitlements" />);
  expect(named.querySelector("a.kit-link")?.getAttribute("aria-label")).toBe(
    "CodeQL #80 in entitlements",
  );
  const plain = await mount(<LinkPill link={link} />);
  expect(plain.querySelector("a.kit-link")?.hasAttribute("aria-label")).toBe(false);
});

it("clicking a pill opens its URL through the bridge and does not reach the row", async () => {
  const spi = installSpi();
  cleanups.push(() => spi.restore());
  const select = vi.fn();
  const url = `${GH}/pull/83`;
  const container = await mount(
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: a stand-in for a selectable row
    <div onClick={select}>
      <LinkPill link={{ kind: "pr", label: "PR #83", url }} />
    </div>,
  );
  const pill = container.querySelector("a.kit-link") as HTMLAnchorElement;
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  await act(async () => pill.dispatchEvent(click));
  expect(spi.spi.openExternal).toHaveBeenCalledExactlyOnceWith(url);
  expect(click.defaultPrevented).toBe(true);
  expect(select).not.toHaveBeenCalled();
});
