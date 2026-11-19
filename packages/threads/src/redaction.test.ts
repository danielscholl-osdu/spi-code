// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import * as threads from "./index.js";

const { ThreadEngine, journalOutputRedactor, modelOutputRedactor, createToolOutputRedactor } =
  threads;

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
const pem = [
  `-----BEGIN ${"OPENSSH PRIVATE KEY"}-----`,
  Buffer.from("FAKE KEY MATERIAL FOR TESTS ONLY").toString("base64"),
  `-----END ${"OPENSSH PRIVATE KEY"}-----`,
];
const privateKey = pem.join("\r\n");

type CorpusEntry = {
  name: string;
  secret: string;
  before?: string;
  after?: string;
  replacement?: string;
};

const modelCorpus: CorpusEntry[] = [
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
  { name: "private key", secret: privateKey },
  { name: "private key missing its footer", secret: pem.slice(0, 2).join("\n") },
  { name: "private key on one line", secret: pem.join(" ") },
  {
    name: "private key with double-escaped line breaks",
    secret: JSON.stringify(JSON.stringify(privateKey).slice(1, -1)).slice(1, -1),
  },
  { name: "private key with escaped line breaks", secret: JSON.stringify(privateKey).slice(1, -1) },
  { name: "host value", secret: knownSecret },
];

const journalOnlyCorpus: CorpusEntry[] = [
  {
    name: "Azure connection string",
    secret: connection,
  },
  {
    name: "Azure Service Bus connection string",
    secret: serviceBus,
  },
  {
    name: "Azure connection starting with AccountKey",
    before: "AccountKey=",
    secret: fakeKey,
    after: ";AccountName=fakeaccount",
  },
  {
    name: "Azure connection starting with SharedAccessKey",
    before: "SharedAccessKey=",
    secret: fakeKey,
    after: ";SharedAccessKeyName=fake-rule;Endpoint=sb://fake.example/",
  },
  {
    name: "kubeconfig client key",
    before: "client-key-data: ",
    secret: Buffer.from("FAKE KEY").toString("base64"),
  },
  {
    name: "kubeconfig certificate",
    before: '"client-certificate-data": "',
    secret: Buffer.from("FAKE FOR TESTING").toString("base64"),
    after: '"',
  },
  {
    name: "kubeconfig JSON user token",
    before: '{"users":[{"user":{"token":"',
    secret: fakeToken,
    after: '"}}]}',
  },
  { name: "kubeconfig token", before: "users:\r\n- user:\r\n    token: ", secret: fakeToken },
  { name: "short kubeconfig token", before: "- user:\n    token: ", secret: "fake-short" },
  {
    name: "kubeconfig client key block",
    before: "    client-key-data: |\r\n      ",
    secret: "FAKE_KEY_PART_ONE\r\n\r\n      FAKE_KEY_PART_TWO",
    replacement: `${marker}\r\n\r\n      ${marker}`,
    after: "\r\n    username: fake-user",
  },
  { name: "bearer header", before: "Authorization: bEaReR  ", secret: fakeToken },
  { name: "Basic header", before: "Authorization: Basic ", secret: `${fakeOpaque}=` },
  {
    name: "Basic header with a quoted credential",
    before: ["Authorization: Basic ", '"'].join(""),
    secret: knownSecret,
    after: '"',
  },
  { name: "Token header", before: "Authorization: Token ", secret: fakeOpaque },
  { name: "Authorization assignment", before: "Authorization=Bearer ", secret: fakeToken },
  {
    name: "Authorization inside JSON",
    before: '{"Authorization":"Bearer ',
    secret: fakeToken,
    after: '"}',
  },
  {
    name: "flow-style kubeconfig token",
    before: "user: {token: ",
    secret: fakeToken,
    after: ", username: fake-user}",
  },
  {
    name: "signature inside a connection string",
    before: "AccountName=fakeaccount;sig=",
    secret: fakeOpaque,
  },
  {
    name: "Azure SAS signature",
    before: "?sv=2025-01-01&sig=",
    secret: `${fakeOpaque}%3D`,
    after: "&sp=r",
  },
];

const journalCorpus: CorpusEntry[] = [
  ...modelCorpus.filter(({ name }) => name !== "host value"),
  ...journalOnlyCorpus,
  {
    name: "Azure shared signature connection string",
    secret: [
      "Endpoint=https://fake.example/",
      `SharedAccessSignature=sv=fixture&sig=${fakeOpaque}`,
    ].join(";"),
  },
  { name: "Azure API key", before: "AZURE_OPENAI_API_KEY=", secret: fakeOpaque },
  { name: "kubeconfig password", before: '    password: "', secret: "test password", after: '"' },
  {
    name: "kubeconfig plain password",
    before: "- user:\n    password: ",
    secret: "fake unquoted password",
    after: " # test fixture",
  },
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
];
const configuredModel = createToolOutputRedactor([knownSecret]).model;

const journalLabels = [
  "AZURE_OPENAI_API_KEY=",
  "AZURE_CLIENT_SECRET=",
  "x-api-key:",
  "api_key:",
  "API_KEY:",
  "client_secret:",
  "access_token:",
  "GH_TOKEN:",
  "GITLAB_TOKEN:",
  "Private-Token:",
  "JOB-TOKEN:",
  "EXAMPLE_SERVICE_CLIENT_SECRET:",
  "client-key-data:",
  "client-certificate-data:",
  "token:",
  "password=",
  "AccountKey=",
  "Authorization: Bearer",
  "Authorization: Basic",
  "Authorization: Token",
  "sig=",
];

const fakeHex = (size: number, first: string) => first + "abc123de".repeat(5).slice(0, size - 1);
const base64 = (text: string) => Buffer.from(text).toString("base64");
const journalShapes = [
  { shape: "32-character letter-first hex", secret: fakeHex(32, "a") },
  { shape: "40-character letter-first hex", secret: fakeHex(40, "a") },
  { shape: "32-character digit-first hex", secret: fakeHex(32, "1") },
  { shape: "40-character digit-first hex", secret: fakeHex(40, "1") },
  { shape: "letter-first base62", secret: "Fake42Aa9Z".repeat(4) },
  { shape: "sk_live style", secret: ["sk", "live", "fake42Qa8".repeat(3)].join("_") },
  { shape: "unpadded base64 (PEM)", secret: base64(privateKey).replace(/=+$/, "") },
  { shape: "unpadded base64 (user:pass)", secret: base64("fake-user:fake-pwd").replace(/=+$/, "") },
  {
    shape: "dash-free JWT",
    secret: [base64('{"alg":"HS256"}'), base64('{"sub":"fake-user"}'), base64("fake-sig")]
      .map((segment) => segment.replace(/=+$/, ""))
      .join("."),
  },
  { shape: "padded", secret: base64("fake fixture auth") },
  { shape: "dashed", secret: fakeToken },
];

it.each(journalLabels.flatMap((label) => journalShapes.map((shape) => ({ label, ...shape }))))(
  "journal redacts $shape after $label",
  ({ label, secret }) => {
    const prefix = label.endsWith("=") ? label : `${label} `;
    expect(journalOutputRedactor.text(prefix + secret)).toBe(prefix + marker);
  },
);

it.each(["token", "password"])("journal masks a %s block without adjacent user fields", (label) => {
  const header = `${label}: >-\r\n`;
  const body = "  fake fixture one\r\n  fake fixture two\r\n";
  const after = "end: visible";
  expect(journalOutputRedactor.text(header + body + after)).toBe(
    `${header}  ${marker}\r\n  ${marker}\r\n${after}`,
  );
  expect(modelOutputRedactor.text(header + body + after)).toBe(header + body + after);
});

it.each(modelCorpus)(
  "redacts $name in results, errors and across every two-chunk split",
  (entry) => {
    const { before = "", secret, after = "", replacement = marker } = entry;
    const raw = `stdout\r\n${before}${secret}${after}\r\n`;
    const expected = `stdout\r\n${before}${replacement}${after}\r\n`;
    expect(configuredModel.value({ outputs: [raw], exitCode: 0 })).toEqual({
      outputs: [expected],
      exitCode: 0,
    });
    expect(configuredModel.value({ error: { message: raw } })).toEqual({
      error: { message: expected },
    });
    for (let split = 1; split < raw.length; split++) {
      expect(configuredModel.chunks([raw.slice(0, split), raw.slice(split)])).toBe(expected);
    }
  },
);

it.each(journalOnlyCorpus)(
  "preserves $name for the model and redacts it for the journal",
  ({ before = "", secret, after = "", replacement = marker }) => {
    const raw = before + secret + after;
    expect(modelOutputRedactor.text(raw)).toBe(raw);
    expect(journalOutputRedactor.text(raw)).toBe(before + replacement + after);
  },
);

it("preserves Authorization inside escaped JSON in both profiles", () => {
  const raw = String.raw`{\"Authorization\": \"Bearer ${fakeToken}\"}`;
  expect(modelOutputRedactor.text(raw)).toBe(raw);
  expect(journalOutputRedactor.text(raw)).toBe(raw);
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

it.each(prefixes)("redacts a PEM excerpt after $name", ({ line }) => {
  const formatted = (lines: string[]) =>
    lines.map((content, index) => line(index + 1) + content).join("\n");
  for (const lines of [pem, pem.slice(0, 2)]) {
    const raw = `${formatted(lines)}\nplain output`;
    const expected = `${line(1)}${marker}\nplain output`;
    expect(modelOutputRedactor.value({ result: raw, error: raw })).toEqual({
      result: expected,
      error: expected,
    });
    for (let split = 1; split < raw.length; split++) {
      expect(modelOutputRedactor.chunks([raw.slice(0, split), raw.slice(split)])).toBe(expected);
    }
  }
});

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
  expect(journalOutputRedactor.text(prefixed(input))).toBe(prefixed(expected));
  const excerpt = `${line(1)}password: fake spaced password!`;
  expect(journalOutputRedactor.text(excerpt)).toBe(`${line(1)}password: ${marker}`);
});

it("redacts both sides of a journaled diff below a kubeconfig block in context", () => {
  const header = "     client-key-data: |";
  const oldLine = "-      ";
  const newLine = "+      ";
  const footer = "     username: fixture";
  expect(
    journalOutputRedactor.text(
      [header, `${oldLine}FAKE_OLD_KEY`, `${newLine}FAKE_NEW_KEY`, footer].join("\n"),
    ),
  ).toBe([header, oldLine + marker, newLine + marker, footer].join("\n"));
});

it.each([
  "if (password == null)",
  "token === undefined",
  "token: string;",
  "token: IdentifierSchema,",
  "token: 'a-horizon-halt-token'",
  "password: 'a fake example password'",
  "- password: The account password",
  "> password: The account password",
  "+password: The account password",
  "1:password: The account password",
  "2026-01-01T12:34:00Z INFO password: reset link sent to user",
  "client-key-data-example: wouldStayByteIdentical",
  "my-token: opaqueLookingIdentifier",
  "TOKEN: opaqueLookingIdentifier",
  "~~~pem\n-----BEGIN PRIVATE KEY-----\n~~~",
  "PEM delimiters: -----BEGIN PRIVATE KEY----- and -----END PRIVATE KEY-----",
  "const token = await getToken();",
  "const sig = sign(payload);",
  "accountKey = props.accountKey",
  'let sig = ""',
  `sig=${fakeOpaque}`,
  `AccountKey=${fakeKey};Unrelated=fixture`,
  `SharedAccessKey=${fakeKey};SharedAccessKeyName=fixture`,
  `AccountName=fixture;accountKey=${fakeKey}`,
  `AccountKey=${fakeKey};accountname=fixture`,
  `AccountName=fixture;AccountKey =${fakeKey}`,
  `AccountName=fixture;AccountKey= ${fakeKey}`,
  `?Sig=${fakeOpaque}&sig =${fakeOpaque}&sig= ${fakeOpaque}`,
  "- user:\n    token: string\n    client-key-data: string",
  ...["...", "{token}", "<placeholder>", `\${KEY}`, "$TOKEN", "$TOKEN$", "short"].flatMap(
    (value) => [
      `Authorization: Bearer ${value}`,
      `Authorization: "Basic ${value}"`,
      `AccountName=fixture;AccountKey=${value};EndpointSuffix=example.com`,
      `?sig=${value}&after=fixture`,
      `-----BEGIN PRIVATE KEY-----\n${value}\n-----END PRIVATE KEY-----`,
    ],
  ),
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
  expect(Buffer.from(modelOutputRedactor.text(line))).toEqual(Buffer.from(line));
  expect(modelOutputRedactor.value({ stdout: line })).toEqual({ stdout: line });
  expect(modelOutputRedactor.value({ error: line })).toEqual({ error: line });
  expect(modelOutputRedactor.chunks([line.slice(0, 8), line.slice(8)])).toBe(line);
});

it("preserves tracked product source byte for byte", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const files = execFileSync("git", ["ls-files", "-z", "--", "apps", "packages", "scripts"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const changed = [];
  let scanned = 0;
  for (const path of files) {
    if (
      /(?:^|\/)(?:test|__tests__|fixtures|__snapshots__)(?:\/|$)/.test(path) ||
      /\.(?:test|spec)\.|\.snap$|(?:^|\/)(?:test-snapshot\.|snapshot-\d+\.)/.test(path) ||
      !/\.(?:[cm]?[jt]sx?|css|html|json|md|sh|svg|ya?ml)$/.test(path)
    )
      continue;
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
    if (!Buffer.from(modelOutputRedactor.text(text)).equals(bytes)) changed.push(path);
  }
  expect(scanned).toBeGreaterThan(0);
  expect(changed).toEqual([]);
});

it.each(["journal", "model"] as const)(
  "redacts exact host values in the %s profile, including overlapping values and split chunks",
  (profile) => {
    const shared = ["v", "8.7"].join("");
    const full = `${shared} POSTGRES ${knownSecret}`;
    const redactor = createToolOutputRedactor([shared, "", full, knownSecret])[profile];
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
    expect(createToolOutputRedactor([coveringCorpus])[profile].text(coveringCorpus)).toBe(marker);
    expect(createToolOutputRedactor([fakeGitHub.slice(0, 8)])[profile].text(fakeGitHub)).toBe(
      marker,
    );
    const overlap = createToolOutputRedactor([knownSecret.slice(0, 10), knownSecret.slice(8)]);
    expect(overlap[profile].text(knownSecret)).toBe(marker);
    const authValue = `Bearer ${knownSecret}`;
    expect(
      createToolOutputRedactor([authValue])[profile].value({ Authorization: authValue }),
    ).toEqual({
      Authorization: marker,
    });
  },
);

it("preserves clean output byte for byte and redacts token prefixes in structured output", () => {
  const clean =
    'résumé\r\nA bearer of good news.\nToken count: 4\ntoken: ""\npassword: null\n\t🌍\u0000';
  const output = { stdout: clean, nested: [null, 0, false, { public: clean }] };
  expect(Buffer.from(modelOutputRedactor.chunks([clean.slice(0, -2), clean.slice(-2)]))).toEqual(
    Buffer.from(clean),
  );
  expect(JSON.stringify(modelOutputRedactor.value(output))).toBe(JSON.stringify(output));
  const structured = { token: fakeGitHub, [fakeGitLab]: "credential used as a key" };
  const redacted = { token: marker, [marker]: "credential used as a key" };
  expect(modelOutputRedactor.value(structured)).toEqual(redacted);
  expect(modelOutputRedactor.value(redacted)).toEqual(redacted);
  const placeholders = {
    user: { token: "string", "client-key-data": `\${KEY}` },
    Authorization: "Bearer {token}",
  };
  expect(modelOutputRedactor.value(placeholders)).toEqual(placeholders);
});

it.each([
  {
    name: "client-key-data",
    raw: { kube: [{ "client-key-data": "FAKE-kubeconfig-data" }] },
    redacted: { kube: [{ "client-key-data": marker }] },
  },
  {
    name: "client-certificate-data",
    raw: { "client-certificate-data": "FAKE-kubeconfig-certificate" },
    redacted: { "client-certificate-data": marker },
  },
  {
    name: "kubeconfig user token",
    raw: { users: [{ user: { token: fakeToken } }] },
    redacted: { users: [{ user: { token: marker } }] },
  },
  {
    name: "Authorization",
    raw: { headers: { Authorization: `Bearer ${fakeToken}` } },
    redacted: { headers: { Authorization: `Bearer ${marker}` } },
  },
])(
  "preserves structured $name for the model and redacts it for the journal",
  ({ raw, redacted }) => {
    expect(modelOutputRedactor.value(raw)).toEqual(raw);
    expect(journalOutputRedactor.value(raw)).toEqual(redacted);
  },
);

it.each([{ mode: "default" }, { mode: "host supplied" }])(
  "writes only sanitized runtime output to the SQLite journal with $mode redaction",
  async ({ mode }) => {
    const database = new DatabaseSync(":memory:");
    try {
      const redactor =
        mode === "host supplied" ? createToolOutputRedactor([knownSecret]).journal : undefined;
      const hostText = redactor ? ` ${knownSecret}` : "";
      const hostMarker = redactor ? ` ${marker}` : "";
      const engine = new ThreadEngine(database, {
        ...(redactor && { redactor }),
        workspace: { resolve: () => ({ cwd: "/workspace" }) },
        context: { prepare: () => ({ instructions: "", attachments: [] }) },
        tools: { offer: () => [] },
        runtime: {
          async run(_input, events) {
            const splitAt = 15;
            events.delta(`Assistant echo: ${fakeGitHub.slice(0, splitAt)}`);
            const midway = database.prepare("SELECT payload FROM thread_engine_journal").all();
            expect(JSON.stringify(midway).includes(fakeGitHub.slice(0, splitAt))).toBe(false);
            events.delta(`${fakeGitHub.slice(splitAt)}${hostText}`);
            const approval = {
              approvalId: "approval",
              kind: "command",
              detail: `Run fixtures: ${fakeGitLab}${hostText}`,
              adapterData: fakeToken,
            };
            void events.requestApproval(approval);
            for (const { name, before = "", secret, after = "" } of journalCorpus) {
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
      expect(persisted.includes(fakeGitHub.slice(0, 15))).toBe(false);
      expect(persisted.includes(fakeGitHub.slice(15))).toBe(false);
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
      for (const { secret, before = "", after = "", name, replacement = marker } of journalCorpus) {
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

it.each([
  { header: pem[0], body: pem[1], end: pem[2], redacted: marker },
  { header: "token: |", body: "  fake block body", end: "", redacted: `token: |\n  ${marker}` },
  {
    header: "- user:",
    body: "    token: fake-token",
    end: "",
    redacted: `- user:\n    token: ${marker}`,
  },
])("resumes assistant streaming after $header", ({ header, body, end, redacted }) => {
  const journal = createToolOutputRedactor(["fake host part one\nfake host part two"]).journal;
  const stream = journal.assistantText();
  const visible = [
    stream.push(`${header}\n`),
    stream.push(`${body}\n`),
    stream.push(`${end ? `${end}\n` : ""}visible after the block\nunfinished`),
  ].join("");
  expect(visible).toBe(`${redacted}\nvisible after the block\n`);

  const multiline = journal.assistantText();
  expect(multiline.push("visible before\nfake host part one\n")).toBe("visible before\n");
  expect(multiline.push("fake host part two\nvisible after\n")).toBe(`${marker}\nvisible after\n`);
});

it.each([undefined, "fake host part one\r\nfake host part two"])(
  "flushes split multiline assistant secrets on shutdown with host value %s",
  async (hostValue) => {
    const database = new DatabaseSync(":memory:");
    try {
      const fakeBlock = "fake block scalar for tests only";
      let started = () => {};
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const engine = new ThreadEngine(database, {
        redactor: createToolOutputRedactor(hostValue ? [hostValue] : []).journal,
        workspace: { resolve: () => ({ cwd: "/workspace" }) },
        context: { prepare: () => ({ instructions: "", attachments: [] }) },
        tools: { offer: () => [] },
        runtime: {
          async run({ signal }, events) {
            const stopped = new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
            events.delta(privateKey.slice(0, 12));
            events.delta(`${privateKey.slice(12)}\r\ntok`);
            events.delta("en: |\r");
            events.delta(`\n  ${fakeBlock.slice(0, 9)}`);
            events.delta(`${fakeBlock.slice(9)}\n- user:\n    to`);
            events.delta("ken: fake-short");
            if (hostValue) {
              events.delta(`\n${hostValue.slice(0, 19)}`);
              events.delta(hostValue.slice(19));
            }
            started();
            await stopped;
          },
        },
      });
      const id = engine.create({ scope: "partition" });
      const outcome = engine.send(id, { prompt: "Run fixtures" });
      await ready;
      expect(engine.read(id).turns[0]?.text).toContain(`${marker}\r\n`);
      await engine.shutdown();
      await expect(outcome).resolves.toBe("cancelled");
      expect(engine.read(id).turns[0]?.text).toBe(
        `${marker}\r\ntoken: |\r\n  ${marker}\n- user:\n    token: ${marker}${hostValue ? `\n${marker}` : ""}`,
      );
      const persisted = JSON.stringify(
        database.prepare("SELECT payload FROM thread_engine_journal").all(),
      );
      for (const fixture of [
        privateKey.slice(0, 12),
        fakeBlock,
        ...(hostValue?.split("\r\n") ?? []),
      ])
        expect(persisted.includes(fixture)).toBe(false);
    } finally {
      database.close();
    }
  },
);

it("sanitizes journal metadata while preserving runtime correlation", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const redactor = createToolOutputRedactor([knownSecret]).journal;
    const engine = new ThreadEngine(database, {
      redactor,
      workspace: { resolve: () => ({ cwd: "/workspace" }) },
      context: { prepare: () => ({ instructions: "", attachments: [] }) },
      tools: { offer: () => [] },
      runtime: {
        async run({ message }, events) {
          expect(message.prompt).toBe(knownSecret);
          const toolId = `call-${knownSecret}`;
          events.toolStarted({ callId: toolId, name: knownSecret, kind: "tool", arguments: {} });
          events.toolFinished({ callId: toolId, outcome: "completed", result: 0 });
          const decision = events.requestApproval({
            approvalId: `approval-${knownSecret}`,
            kind: knownSecret,
            detail: "Read the fixture",
          });
          const approval = engine.read(id).turns[0]?.approvals[0]?.request;
          if (!approval) throw new Error("Missing approval event");
          expect(engine.decideApproval(id, approval.turnId, approval.approvalId, true)).toBe(true);
          await expect(decision).resolves.toBe(true);
        },
      },
    });
    const id = engine.create({ scope: "partition", title: knownSecret });
    await expect(
      engine.send(id, {
        prompt: knownSecret,
        attachments: [{ name: knownSecret, content: knownSecret }],
      }),
    ).resolves.toBe("completed");
    expect(engine.read(id).turns[0]?.tools[0]?.end).toMatchObject({ result: 0 });
    const persisted = JSON.stringify(
      database.prepare("SELECT payload FROM thread_engine_journal").all(),
    );
    expect(persisted.includes(knownSecret)).toBe(false);
  } finally {
    database.close();
  }
});
