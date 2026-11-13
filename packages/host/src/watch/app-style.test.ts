// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it } from "vitest";
import { watchOutputs } from "../../test/watch/outputs.js";
import { appStyle, fixtureInput } from "../../test/watch/snapshot-fixture.js";
import { projectWatch } from "./project.js";

it("keeps oracle inputs on clock text beside the app snapshot path", async () => {
  const input = fixtureInput();
  expect(input.context.timeStyle).toBe("clock");
  const app = appStyle(input);
  expect(app.context.timeStyle).toBe("instant");
  expect(input.context.timeStyle).toBe("clock");
  const output = watchOutputs.find(({ path }) => path === "fixtures/watch/snapshot-59d6895.json");
  expect(output).toBeDefined();
  const saved = await output?.value();
  expect(saved).toEqual(projectWatch(app));
  expect(saved).not.toEqual(projectWatch(input));
});
