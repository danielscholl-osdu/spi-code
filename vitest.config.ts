// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
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
          name: directory,
          include: [`${directory}/src/**/*.test.{ts,tsx}`],
          environment: "node",
        },
      })),
    ],
  },
});
