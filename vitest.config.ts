// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const setupFiles =
  process.env.SPI_TEST_CLOCK_SHIFT === "1"
    ? [fileURLToPath(new URL("./scripts/shift-test-clock.ts", import.meta.url))]
    : [];

// Time budgets sized for scripts/check on a machine busy with parallel worktree builds;
// the boundary scans parse every source and the exec tests spawn real process trees.
const timeouts = { testTimeout: 30_000, hookTimeout: 30_000 };

export default defineConfig({
  test: {
    ...timeouts,
    projects: [
      {
        test: {
          ...timeouts,
          setupFiles,
          name: "scripts",
          include: ["scripts/**/*.test.ts"],
          environment: "node",
        },
      },
      ...[
        "apps/desktop",
        "apps/window",
        "packages/contracts",
        "packages/core",
        "packages/host",
        "packages/tools",
      ].map((directory) => ({
        test: {
          ...timeouts,
          setupFiles:
            directory === "apps/window"
              ? [
                  ...setupFiles,
                  fileURLToPath(
                    new URL("./apps/window/src/test-utils/web-storage.ts", import.meta.url),
                  ),
                ]
              : setupFiles,
          name: directory,
          include: [
            `${directory}/src/**/*.test.{ts,tsx}`,
            ...(directory === "packages/core" ? [`${directory}/test/**/*.test.ts`] : []),
          ],
          environment: directory === "apps/window" ? "happy-dom" : "node",
        },
      })),
    ],
  },
});
