// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { SecurityPaneSchema } from "@spi-code/contracts";
import { act } from "react";
import { expect, it } from "vitest";
import {
  readFixture,
  readGenerated,
  verifyGenerated,
} from "../../../../scripts/watch-generated.mjs";
import { directoryPaths } from "../test-utils/directory-paths.test.js";
import { fixtureLoader } from "../test-utils/harness.js";
import { assertRules, container, open, shellHooks } from "./text-rules.test-helper.js";

shellHooks();
const base = fixtureLoader(readFixture)("snapshot-59d6895.json");
const panes = directoryPaths(join(verifyGenerated(), "security"))
  .filter((name) => name.endsWith(".json"))
  .sort();

const click = async (selector: string) => {
  const target = container.querySelector<HTMLElement>(selector);
  if (!target) return false;
  await act(async () => target.click());
  return true;
};

it("reads every generated Security pane", () => {
  expect(panes).toEqual(expect.arrayContaining(["1116.json", "partial.json", "clean.json"]));
});

it.each(panes)(
  "holds the window's text rules on the Security page over %s, in every bar and view",
  async (name) => {
    const security = SecurityPaneSchema.parse(JSON.parse(readGenerated(`security/${name}`)));
    await open({ ...structuredClone(base), security }, { kind: "security" });
    assertRules(`${name} as it opens`);
    if (!security.read) return;
    for (const lane of security.lanes) {
      const at = `${name} ${lane.id}`;
      await click(`.security-fig-row[data-lane="${lane.id}"] .security-fig-name`);
      assertRules(`${at} by rule`);
      if (await click(".security-rule .security-rule-title")) assertRules(`${at} opened rule`);
      if (await click(".security-views button:last-child")) {
        assertRules(`${at} by repository`);
        if (await click(".security-repo .security-repo-alerts"))
          assertRules(`${at} opened repository`);
        await click(".security-views button:first-child");
      }
    }
  },
);
