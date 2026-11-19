// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { ThreadEngine, toolOutputRedactor } from "./index.js";

const marker = "[redacted]";
const fakeKey = "FAKE".repeat(8);
const fakeToken = "fake-token-for-tests-only";
const connection = [
  "DefaultEndpointsProtocol=https",
  "AccountName=fakeaccount",
  `Account${"Key"}=${fakeKey}`,
  "EndpointSuffix=core.windows.net",
].join(";");
const serviceBus = [
  "Endpoint=sb://fake.servicebus.windows.net/",
  "SharedAccessKeyName=fake-rule",
  `SharedAccess${"Key"}=${fakeKey}`,
].join(";");
const privateKey = [
  `-----BEGIN ${"OPENSSH PRIVATE KEY"}-----`,
  "FAKE KEY MATERIAL FOR TESTS ONLY",
  `-----END ${"OPENSSH PRIVATE KEY"}-----`,
].join("\r\n");

const corpus = [
  { name: "GitHub classic", secret: ["gh", "p_", "FAKE".repeat(9)].join("") },
  { name: "GitHub fine-grained", secret: ["github", "_pat_", "FAKE_".repeat(16)].join("") },
  { name: "GitLab personal", secret: ["gl", "pat-", fakeToken].join("") },
  { name: "GitLab runner", secret: ["gl", "rt-", fakeToken].join("") },
  { name: "Azure API key", before: "AZURE_OPENAI_API_KEY=", secret: fakeKey },
  { name: "Azure connection string", secret: connection },
  { name: "Azure Service Bus connection string", secret: serviceBus },
  { name: "kubeconfig token", before: "users:\r\n- user:\r\n    token: ", secret: fakeToken },
  { name: "kubeconfig password", before: '    password: "', secret: "test password", after: '"' },
  {
    name: "kubeconfig plain password",
    before: "    password: ",
    secret: "fake unquoted password",
    after: " # test fixture",
  },
  {
    name: "kubeconfig client key block",
    before: "    client-key-data: |\r\n      ",
    secret: "FAKE_KEY_PART_ONE\r\n\r\n      FAKE_KEY_PART_TWO",
    after: "\r\n    username: fake-user",
  },
  { name: "bearer header", before: "Authorization: bEaReR  ", secret: fakeToken },
  { name: "private key", secret: privateKey },
];

it.each(corpus)("redacts $name in results, errors and across every two-chunk split", (entry) => {
  const { before = "", secret, after = "" } = entry;
  const raw = `stdout\r\n${before}${secret}${after}\r\n`;
  const expected = `stdout\r\n${before}${marker}${after}\r\n`;
  expect(toolOutputRedactor.value({ outputs: [raw], exitCode: 0 })).toEqual({
    outputs: [expected],
    exitCode: 0,
  });
  expect(toolOutputRedactor.value({ error: { message: raw } })).toEqual({
    error: { message: expected },
  });
  for (let split = 1; split < raw.length; split++) {
    expect(toolOutputRedactor.chunks([raw.slice(0, split), raw.slice(split)])).toBe(expected);
  }
});

it("preserves clean output byte for byte and redacts credential fields and keys in structured output", () => {
  const clean =
    'résumé\r\nA bearer of good news.\nToken count: 4\ntoken: ""\npassword: null\n\t🌍\u0000';
  const output = { stdout: clean, nested: [null, 0, false, { public: clean }] };
  expect(Buffer.from(toolOutputRedactor.chunks([clean.slice(0, -2), clean.slice(-2)]))).toEqual(
    Buffer.from(clean),
  );
  expect(JSON.stringify(toolOutputRedactor.value(output))).toBe(JSON.stringify(output));
  const clientKey = "FAKE-kubeconfig-data";
  const gitLab = ["gl", "pat-", fakeToken].join("");
  const structured = {
    kube: [{ "client-key-data": clientKey, "client-certificate": "path/to/public.cert" }],
    headers: { Authorization: `Bearer ${fakeToken}` },
    [gitLab]: "credential used as a key",
  };
  const redacted = {
    kube: [{ "client-key-data": marker, "client-certificate": "path/to/public.cert" }],
    headers: { Authorization: `Bearer ${marker}` },
    [marker]: "credential used as a key",
  };
  expect(toolOutputRedactor.value(structured)).toEqual(redacted);
  expect(toolOutputRedactor.value(redacted)).toEqual(redacted);
});

it("writes only sanitized completed results and failures to the SQLite journal", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const engine = new ThreadEngine(database, {
      workspace: { resolve: () => ({ cwd: "/workspace" }) },
      context: { prepare: () => ({ instructions: "", attachments: [] }) },
      tools: { offer: () => [] },
      runtime: {
        async run(_input, events) {
          const approval = {
            approvalId: "approval",
            kind: "command",
            detail: "Run fixtures",
            adapterData: fakeToken,
          };
          void events.requestApproval(approval);
          for (const { name, before = "", secret, after = "" } of corpus) {
            const command = {
              callId: name,
              kind: "command" as const,
              name: "fixture",
              arguments: {},
              adapterData: secret,
            };
            events.toolStarted(command);
            const split = Math.floor(secret.length / 2);
            const completion = {
              callId: name,
              outcome: "completed" as const,
              resultChunks: [
                `${before}${secret.slice(0, split)}`,
                `${secret.slice(split)}${after}`,
              ],
              adapterData: secret,
            };
            events.toolFinished(completion);
            const callId = `${name}-failed`;
            events.toolStarted({ ...command, callId });
            const failure = {
              callId,
              outcome: "failed" as const,
              result: { error: `${before}${secret}${after}` },
              adapterData: secret,
            };
            events.toolFinished(failure);
          }
        },
      },
    });
    const id = engine.create({ scope: "partition" });
    await expect(engine.send(id, { prompt: "Run fixtures" })).resolves.toBe("completed");
    const rows = database.prepare("SELECT payload FROM thread_engine_journal").all();
    const persisted = JSON.stringify(rows);
    expect(persisted.includes("adapterData")).toBe(false);
    for (const { secret, before = "", after = "", name } of corpus) {
      const encoded = JSON.stringify(secret).slice(1, -1);
      expect(
        rows.some(({ payload }) => typeof payload === "string" && payload.includes(encoded)),
        name,
      ).toBe(false);
      const sanitized = `${before}${marker}${after}`;
      const [complete, failed] = engine
        .eventsSince(id, 0)
        .filter(
          (event) =>
            event.type === "tool.finished" &&
            (event.callId === name || event.callId === `${name}-failed`),
        );
      expect(complete).toMatchObject({
        outcome: "completed",
        result: sanitized,
        resultBytes: Buffer.byteLength(JSON.stringify(sanitized)),
      });
      expect(failed).toMatchObject({ outcome: "failed", result: { error: sanitized } });
    }
  } finally {
    database.close();
  }
});
