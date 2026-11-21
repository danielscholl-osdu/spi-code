// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import type { InspectResult, ViewSnapshot } from "@spi-code/contracts";
import { createToolOutputRedactor, type JsonValue, journalOutputRedactor } from "@spi-code/threads";
import { expect, it } from "vitest";
import { watchFixtures } from "../../../../../scripts/watch-generated.mjs";
import { detailFeedPath, recordedSnapshotPath } from "../../../test/watch/snapshot-fixture.js";
import { FakeSession } from "../../testing/fake-session.js";
import { buildPermissionGate } from "../../tools/permission-gate.js";
import { spiReadTools, spiToolProvider } from "../../tools/spi-reads.js";
import { packChip } from "./chip.js";
import { chipFromSweep } from "./draft.js";
import { redactSpiValue } from "./redaction.js";
import type { SavedSweep } from "./sweep.js";

const view: ViewSnapshot = JSON.parse(readFileSync(recordedSnapshotPath, "utf8"));
const feed: InspectResult[] = JSON.parse(readFileSync(detailFeedPath, "utf8"));

it("keeps every recorded and generated watch fixture byte-identical through SPI value redaction", () => {
  const fixtures = watchFixtures();
  expect(fixtures.some(({ path }) => path.includes("generated"))).toBe(true);
  for (const { name, path } of fixtures) {
    const value: JsonValue = JSON.parse(readFileSync(path, "utf8"));
    const copy = redactSpiValue(value, journalOutputRedactor);
    expect(JSON.stringify(copy) === JSON.stringify(value), name).toBe(true);
  }
});

it("exempts only a horizon card theme at the snapshot's exact path", () => {
  const card = {
    id: "theme:fixture",
    kind: "sync",
    token: "Sync upstream",
    services: [],
    needsYou: false,
    itemIds: [],
    text: "The next sync.",
  };
  const known = "fixture-known-credential";
  const raw = "fixture-kubeconfig-credential";
  const fakeHub = ["gh", "p_", "FAKE".repeat(9)].join("");
  const cards = [card, { ...card, token: known }, { ...card, token: fakeHub }, { token: raw }];
  const briefing = { horizon: { cards } };
  const { journal } = createToolOutputRedactor([known]);
  const safe = redactSpiValue(
    {
      briefing,
      token: raw,
      cards,
      nested: { briefing, token: raw },
    },
    journal,
  );
  const maskedCards = cards.map((entry) => ({ ...entry, token: "[redacted]" }));
  expect(safe).toEqual({
    briefing: { horizon: { cards: [card, ...maskedCards.slice(1)] } },
    token: "[redacted]",
    cards: maskedCards,
    nested: { briefing: { horizon: { cards: maskedCards } }, token: "[redacted]" },
  });
  expect(redactSpiValue({ briefing: { horizon: { cards: { "0": card } } } }, journal)).toEqual({
    briefing: { horizon: { cards: { "0": maskedCards[0] } } },
  });
});

const corpus = [
  {
    name: "Azure connection string",
    secret: "FAKE".repeat(8),
    text: (secret: string) =>
      `DefaultEndpointsProtocol=https;AccountName=fixture;AccountKey=${secret};EndpointSuffix=example.com`,
    masked: "[redacted]",
  },
  {
    name: "SAS sig",
    secret: "fake-sas-signature",
    text: (secret: string) => `https://fixture.example/blob?sv=1&sig=${secret}&sp=r`,
    field: "sig",
  },
  {
    name: "Authorization",
    secret: "fake-authorization-credential",
    text: (secret: string) => `Authorization: Bearer ${secret}`,
    field: "Authorization",
  },
  {
    name: "kubeconfig client-key-data",
    secret: "fake-kubeconfig-key-data",
    text: (secret: string) => `users:\n- user:\n    client-key-data: ${secret}`,
    field: "client-key-data",
  },
  {
    name: "kubeconfig client-certificate-data",
    secret: "fake-kubeconfig-certificate-data",
    text: (secret: string) => `users:\n- user:\n    client-certificate-data: ${secret}`,
    field: "client-certificate-data",
  },
  {
    name: "kubeconfig token",
    secret: "fake-short",
    text: (secret: string) => `users:\n- user:\n    token: ${secret}`,
    field: "token",
  },
  {
    name: "kubeconfig JSON user token",
    secret: "fake-token-for-tests-only",
    text: (secret: string) => JSON.stringify({ users: [{ user: { token: secret } }] }),
    field: "token",
  },
];

it.each(corpus)(
  "masks $name in a result, an error, spi_stack and a chip",
  async ({ secret, text, field, masked }) => {
    const sample = feed.find(({ id }) => id === "rollout");
    const record = feed.find(({ id }) => id === "radar:partition")?.evidence[0];
    if (!sample || !record) throw new Error("Missing fixture inspect data");
    const key = field === "Authorization" ? `Bearer ${secret}` : secret;
    const credentials = field ? { [field]: key } : {};
    const result = { ...sample, evidence: [{ ...record, object: text(secret), credentials }] };
    const answer = { kind: "queue item", result };
    const readings = view.readings.map((reading) =>
      reading.anchor.kind === "environment" && reading.content
        ? { ...reading, content: { ...reading.content, headline: text(secret) } }
        : reading,
    );
    const sweep: SavedSweep = {
      view: { ...view, readings },
      reads: {},
      inspect: async (id) => {
        if (id === "error") throw new Error(text(secret));
        return answer;
      },
    };
    const tools = spiToolProvider(spiReadTools(() => sweep, journalOutputRedactor)).offer();
    const session = new FakeSession({
      tools,
      availableTools: tools.map(({ name }) => `custom:${name}`),
      onPermissionRequest: buildPermissionGate(),
    });
    const output = await session.callTool("spi_inspect", { id: "rollout" });
    const expected = field ? { [field]: key.replace(secret, "[redacted]") } : {};
    const redactedText = masked ?? text("[redacted]");
    const evidence = { object: redactedText, credentials: expected };
    expect(JSON.parse(String(output))).toMatchObject({ item: { evidence: [evidence] } });
    const error = session.callTool("spi_inspect", { id: "error" });
    await expect(error).rejects.toThrow(redactedText);
    await expect(error).rejects.not.toThrow(secret);

    const stack = JSON.parse(String(await session.callTool("spi_stack", {})));
    expect(stack.reading.headline).toBe(redactedText);
    expect(JSON.stringify(stack)).not.toContain(secret);
    const place = await chipFromSweep(() => sweep, "place:environment", journalOutputRedactor);
    if (!place.ok) throw new Error(place.reason);
    expect(place.chip.chip).toMatchObject({ reading: { headline: redactedText } });
    expect(place.chip.content).not.toContain(secret);

    const packed = packChip(answer, { sweptAt: view.sweptAt, reads: {} }, journalOutputRedactor);
    if (!packed.ok) throw new Error(packed.reason);
    expect(packed.chip.chip.evidence).toMatchObject([evidence]);
    expect(packed.chip.content).not.toContain(secret);
  },
);
