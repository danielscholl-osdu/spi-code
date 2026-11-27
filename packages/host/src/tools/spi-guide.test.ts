// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { FakeSession } from "../testing/fake-session.js";
import { allGuides } from "../threads/context/knowledge.js";
import { buildPermissionGate } from "./permission-gate.js";
import { spiGuideTool } from "./spi-guide.js";
import { isSpiReadTool, SPI_RESULT_BYTE_BUDGET } from "./spi-reads.js";

async function call(args: object) {
  const { tool } = spiGuideTool();
  const session = new FakeSession({
    tools: [tool],
    availableTools: [`custom:${tool.name}`],
    onPermissionRequest: buildPermissionGate(),
  });
  const output = await session.callTool(tool.name, args);
  if (typeof output !== "string") throw new Error(`spi_guide answered ${typeof output}`);
  return { output, answer: JSON.parse(output) };
}

describe("spi_guide", () => {
  it.each(allGuides().map((guide) => [guide.id, guide] as const))(
    "answers %s with its steps and what they were checked against, inside the result budget",
    async (id, guide) => {
      const { output, answer } = await call({ id });
      expect(answer).toEqual({
        guide: id,
        title: guide.title,
        checked: guide.checked,
        steps: guide.steps,
      });
      expect(guide.checked).not.toBe("");
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(SPI_RESULT_BYTE_BUDGET);
    },
  );

  it("answers an id it does not know with the ids it has, and finds one by any case", async () => {
    const { answer } = await call({ id: "ports" });
    expect(answer).toMatchObject({ found: false, reason: "No guide ports." });
    expect(answer.guides).toEqual(allGuides().map(({ id, when }) => ({ id, when })));
    expect((await call({ id: " Cascade " })).answer.guide).toBe("cascade");
  });

  it("is a read the permission gate passes without asking", () => {
    expect(isSpiReadTool(spiGuideTool().name)).toBe(true);
    expect(spiGuideTool().tier).toBe("Read");
  });

  it("refuses arguments it does not take", async () => {
    await expect(call({})).rejects.toThrow("arguments refused");
    await expect(call({ id: "cascade", service: "legal" })).rejects.toThrow("arguments refused");
  });

  it("gives every guide its own id and a scope kind to appear in", () => {
    const ids = allGuides().map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const guide of allGuides()) expect(guide.kinds.length).toBeGreaterThan(0);
  });
});
