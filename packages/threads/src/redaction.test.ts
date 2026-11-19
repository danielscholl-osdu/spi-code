// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import * as threads from "./index.js";

const { ThreadEngine, toolOutputRedactor } = threads;

const marker = "[redacted]";
const fakeKey = "FAKE".repeat(8);
const fakeToken = "fake-token-for-tests-only";
const fakeGitHub = ["gh", "p_", "FAKE".repeat(9)].join("");
const fakeGitLab = ["gl", "pat-", fakeToken].join("");
const fakeOpaque = ["8", "abcdef", "ZyXwVu", "54321"].join("");
const knownSecret = ["demo", " a.b+c? ", "$&"].join("");
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
  { name: "GitHub classic", secret: fakeGitHub },
  {
    name: "GitHub after an escaped newline",
    before: String.raw`{"out":"\n`,
    secret: fakeGitHub,
    after: '"}',
  },
  { name: "GitHub after an encoded equals", before: "%3D", secret: fakeGitHub },
  { name: "GitHub after a word prefix", before: "PREFIX_", secret: fakeGitHub },
  { name: "GitHub fine-grained", secret: ["github", "_pat_", "FAKE_".repeat(16)].join("") },
  { name: "GitLab personal", secret: fakeGitLab },
  {
    name: "GitLab after an escaped newline",
    before: String.raw`{"out":"\n`,
    secret: fakeGitLab,
    after: '"}',
  },
  { name: "GitLab after an encoded equals", before: "%3D", secret: fakeGitLab },
  { name: "GitLab after a word prefix", before: "PREFIX_", secret: fakeGitLab },
  { name: "GitLab runner", secret: ["gl", "rt-", fakeToken].join("") },
  { name: "Azure API key", before: "AZURE_OPENAI_API_KEY=", secret: fakeOpaque },
  { name: "Azure connection string", secret: connection },
  { name: "Azure Service Bus connection string", secret: serviceBus },
  { name: "kubeconfig token", before: "users:\r\n- user:\r\n    token: ", secret: fakeToken },
  { name: "kubeconfig password", before: '    password: "', secret: "test password", after: '"' },
  {
    name: "kubeconfig plain password",
    before: "- user:\n    password: ",
    secret: "fake unquoted password",
    after: " # test fixture",
  },
  {
    name: "kubeconfig client key block",
    before: "    client-key-data: |\r\n      ",
    secret: "FAKE_KEY_PART_ONE\r\n\r\n      FAKE_KEY_PART_TWO",
    replacement: `${marker}\r\n\r\n      ${marker}`,
    after: "\r\n    username: fake-user",
  },
  { name: "bearer header", before: "Authorization: bEaReR  ", secret: fakeToken },
  { name: "private key", secret: privateKey },
  ...[
    "x-api-key",
    "api_key",
    "API_KEY",
    "client_secret",
    "access_token",
    "GH_TOKEN",
    "GITLAB_TOKEN",
    "Private-Token",
    "JOB-TOKEN",
    "EXAMPLE_SERVICE_CLIENT_SECRET",
  ].map((label) => ({ name: label, before: `${label}: `, secret: fakeOpaque })),
  { name: "Basic header", before: "Authorization: Basic ", secret: `${fakeOpaque}=` },
  {
    name: "Basic header with a quoted credential",
    before: ["Authorization: Basic ", '"'].join(""),
    secret: knownSecret,
    after: '"',
  },
  { name: "Token header", before: "Authorization: Token ", secret: fakeOpaque },
  {
    name: "Azure SAS signature",
    before: "?sv=2025-01-01&sig=",
    secret: `${fakeOpaque}%3D`,
    after: "&sp=r",
  },
];

it.each(corpus)("redacts $name in results, errors and across every two-chunk split", (entry) => {
  const { before = "", secret, after = "", replacement = marker } = entry;
  const raw = `stdout\r\n${before}${secret}${after}\r\n`;
  const expected = `stdout\r\n${before}${replacement}${after}\r\n`;
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

const prefixes = [
  { name: "cat -n", line: (n: number) => `${String(n).padStart(6)}\t` },
  { name: "grep -n", line: (n: number) => `${n}:` },
  { name: "file:line:", line: (n: number) => `config.yaml:${n}:` },
  { name: "diff addition", line: () => "+" },
  { name: "diff deletion", line: () => "-" },
  { name: "quotation", line: () => "> " },
  { name: "timestamp", line: (n: number) => `2026-01-01T12:34:0${n}.123Z ` },
];

it.each(
  prefixes.flatMap((prefix) => [
    { ...prefix, newline: "LF", eol: "\n" },
    { ...prefix, newline: "CRLF", eol: "\r\n" },
  ]),
)("redacts kubeconfig blocks and spaced passwords after $name with $newline", ({ line, eol }) => {
  const input = [
    "    client-key-data: |",
    "      FAKE_KEY_PART_ONE",
    "",
    "      FAKE_KEY_PART_TWO",
    "    password: fake unquoted password # fixture",
    "    username: test-user",
  ];
  const expected = [
    "    client-key-data: |",
    `      ${marker}`,
    "",
    `      ${marker}`,
    `    password: ${marker} # fixture`,
    "    username: test-user",
  ];
  const prefixed = (lines: string[]) =>
    lines.map((content, index) => line(index + 1) + content).join(eol);
  expect(toolOutputRedactor.text(prefixed(input))).toBe(prefixed(expected));
  const excerpt = `${line(1)}password: fake spaced password!`;
  expect(toolOutputRedactor.text(excerpt)).toBe(`${line(1)}password: ${marker}`);
});

it("redacts both sides of a diff below a kubeconfig block in context", () => {
  const header = "     client-key-data: |";
  const oldLine = "-      ";
  const newLine = "+      ";
  const footer = "     username: fixture";
  expect(
    toolOutputRedactor.text(
      [header, `${oldLine}FAKE_OLD_KEY`, `${newLine}FAKE_NEW_KEY`, footer].join("\n"),
    ),
  ).toBe([header, oldLine + marker, newLine + marker, footer].join("\n"));
});

it.each([
  "if (password == null)",
  "token === undefined",
  "token: string;",
  "const token = await getToken();",
  "apiKey: props.apiKey,",
  "password: true",
  `token: \${{ secrets.X }}`,
  "Token count: 4",
  "password => check(password)",
  "password = =",
  "password = >",
  "password: >\n  threshold",
  "token: opaqueLookingIdentifier",
  "token: opaqueLookingIdentifier.member",
  "token: opaqueLookingIdentifier?.member",
  "token: opaqueLookingIdentifier['member']",
  "token: verifyToken(123)",
  "password: 12345678901234567890",
  "password: 1234567890.01234567890",
  "password: 0x1234567890abcdef",
  "token: null",
  `token: \`prefix-\${name}\``,
  "password: read the docs first",
  "12:    password: keyof LongNamedObject",
  "token: 'Sync upstream'",
  "token: 'd3ddff5'",
])("preserves ordinary text in %s", (line) => {
  expect(toolOutputRedactor.text(line)).toBe(line);
});

const trackedFixtures = {
  "apps/desktop/src/smoke-messages.test.ts": "fake sign-in token in a smoke payload",
  "apps/window/src/store/watch.test.ts": "fake setup and sign-in tokens",
  "apps/window/src/views/setup/setup.test.tsx": "fake tokens pasted into setup",
  "packages/contracts/src/watch/messages.test.ts": "fake sign-in tokens in contract payloads",
  "packages/core/src/exec/exec.test.ts": "Bearer text used as a redaction fixture",
  "packages/core/src/exec/redact.test.ts": "Bearer text and a planted token for the core redactor",
  "packages/host/src/copilot/runtime.test.ts": "fake credentials in env and Copilot auth payloads",
  "packages/host/src/exec/host-exec.test.ts": "fake tool and shell auth tokens",
  "packages/host/src/process/connections.test.ts": "fake token in an IPC payload",
  "packages/host/src/process/conversation.test.ts": "fake token in an IPC payload",
  "packages/host/src/process/port.test.ts": "fake token in an IPC payload",
  "packages/host/src/sandbox/seatbelt.test.ts": "fake secret environment variables",
  "packages/host/src/setup/seat.test.ts": "fake GitHub token in sandbox environment",
  "packages/host/src/setup/service.test.ts": "fake tokens exercised by sign-in routes",
  "packages/host/src/setup/signin.test.ts": "fake sign-in token constant",
  "packages/host/src/watch/horizon-cards.test.ts": "quoted halt token shaped like a credential",
  "scripts/audit-exec-log.test.ts": "fake password and credential environment variables",
  "scripts/record-sweep.test.ts": "localhost TLS test key and fake forge credentials",
};

it("preserves eligible tracked text files byte for byte except credential-shaped fixtures", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const changed = [];
  let scanned = 0;
  for (const path of files) {
    const file = join(root, path);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size > 1024 * 1024) continue;
    const bytes = readFileSync(file);
    if (bytes.includes(0)) continue;
    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      continue;
    }
    scanned++;
    if (!Buffer.from(toolOutputRedactor.text(text)).equals(bytes)) changed.push(path);
  }
  expect(scanned).toBeGreaterThan(0);
  expect(changed.sort()).toEqual(Object.keys(trackedFixtures).sort());
});

it("redacts exact host values, including overlapping values and values split across chunks", () => {
  const shared = ["v", "8.7"].join("");
  const full = `${shared} POSTGRES ${knownSecret}`;
  const redactor = threads.createToolOutputRedactor([shared, "", full, knownSecret]);
  expect(redactor.chunks([full.slice(0, 6), full.slice(6), ` ${shared}.0`])).toBe(
    `${marker} ${marker}.0`,
  );
  expect(
    redactor.value({ [knownSecret]: [`host: ${knownSecret}`, `corpus: ${fakeGitHub}`] }),
  ).toEqual({
    [marker]: [`host: ${marker}`, `corpus: ${marker}`],
  });
  expect(redactor.text(knownSecret.toUpperCase())).toBe(knownSecret.toUpperCase());
  const coveringCorpus = `known ${fakeGitHub} suffix`;
  expect(threads.createToolOutputRedactor([coveringCorpus]).text(coveringCorpus)).toBe(marker);
  const authValue = `Bearer ${knownSecret}`;
  expect(threads.createToolOutputRedactor([authValue]).value({ Authorization: authValue })).toEqual(
    {
      Authorization: marker,
    },
  );
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

  const structured = {
    kube: [{ "client-key-data": clientKey, "client-certificate": "path/to/public.cert" }],
    headers: { Authorization: `Bearer ${fakeToken}` },
    [fakeGitLab]: "credential used as a key",
  };
  const redacted = {
    kube: [{ "client-key-data": marker, "client-certificate": "path/to/public.cert" }],
    headers: { Authorization: `Bearer ${marker}` },
    [marker]: "credential used as a key",
  };
  expect(toolOutputRedactor.value(structured)).toEqual(redacted);
  expect(toolOutputRedactor.value(redacted)).toEqual(redacted);
});

it.each([{ mode: "default" }, { mode: "host supplied" }])(
  "writes only sanitized runtime output to the SQLite journal with $mode redaction",
  async ({ mode }) => {
    const database = new DatabaseSync(":memory:");
    try {
      const redactor =
        mode === "host supplied" ? threads.createToolOutputRedactor([knownSecret]) : undefined;
      const hostText = redactor ? ` ${knownSecret}` : "";
      const hostMarker = redactor ? ` ${marker}` : "";
      const engine = new ThreadEngine(database, {
        ...(redactor && { redactor }),
        workspace: { resolve: () => ({ cwd: "/workspace" }) },
        context: { prepare: () => ({ instructions: "", attachments: [] }) },
        tools: { offer: () => [] },
        runtime: {
          async run(_input, events) {
            events.delta(`Assistant echo: ${fakeGitHub}${hostText}`);
            const approval = {
              approvalId: "approval",
              kind: "command",
              detail: `Run fixtures: ${fakeGitLab}${hostText}`,
              adapterData: fakeToken,
            };
            void events.requestApproval(approval);
            for (const { name, before = "", secret, after = "" } of corpus) {
              const command = {
                callId: name,
                kind: "command" as const,
                name: "fixture",
                arguments: { command: `echo ${fakeGitHub}${hostText}` },
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
            if (redactor) {
              events.toolStarted({ callId: "host", name: "fixture", kind: "tool", arguments: {} });
              events.toolFinished({
                callId: "host",
                outcome: "completed",
                resultChunks: [hostText],
              });
              events.toolStarted({
                callId: "host-error",
                name: "fixture",
                kind: "tool",
                arguments: {},
              });
              events.toolFinished({
                callId: "host-error",
                outcome: "failed",
                result: { error: hostText },
              });
            }
          },
        },
      });
      const id = engine.create({ scope: "partition" });
      await expect(engine.send(id, { prompt: "Run fixtures" })).resolves.toBe("completed");
      const rows = database.prepare("SELECT payload FROM thread_engine_journal").all();
      const persisted = JSON.stringify(rows);
      expect(persisted.includes("adapterData")).toBe(false);
      expect(persisted.includes(knownSecret)).toBe(false);
      const events = engine.eventsSince(id, 0);
      expect(events.find(({ type }) => type === "assistant.delta")).toMatchObject({
        text: `Assistant echo: ${marker}${hostMarker}`,
      });
      expect(events.find(({ type }) => type === "approval.requested")).toMatchObject({
        detail: `Run fixtures: ${marker}${hostMarker}`,
      });
      expect(events.find(({ type }) => type === "tool.started")).toMatchObject({
        arguments: { command: `echo ${marker}${hostMarker}` },
      });
      if (redactor) {
        expect(
          events.find((event) => event.type === "tool.finished" && event.callId === "host"),
        ).toMatchObject({ result: hostMarker });
        expect(
          events.find((event) => event.type === "tool.finished" && event.callId === "host-error"),
        ).toMatchObject({ result: { error: hostMarker } });
      }
      for (const { secret, before = "", after = "", name, replacement = marker } of corpus) {
        const encoded = JSON.stringify(secret).slice(1, -1);
        expect(
          rows.some(({ payload }) => typeof payload === "string" && payload.includes(encoded)),
          name,
        ).toBe(false);
        const sanitized = `${before}${replacement}${after}`;
        const [complete, failed] = events.filter(
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
  },
);
