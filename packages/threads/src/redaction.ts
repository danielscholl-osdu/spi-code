// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { JsonValue } from "./types.js";

export interface ToolOutputRedactor {
  text(output: string): string;
  value(output: JsonValue): JsonValue;
  /** Buffer one complete output in order. Only the returned text is safe to forward. */
  chunks(output: Iterable<string>): string;
}

interface AssistantText {
  push(delta: string): string;
  remaining(): string;
}

export interface JournalOutputRedactor extends ToolOutputRedactor {
  assistantText(): AssistantText;
}

const marker = "[redacted]";
const fields = [
  "AccountKey",
  "SharedAccessKey",
  "SharedAccessSignature",
  "AZURE_OPENAI_API_KEY",
  "AZURE_API_KEY",
  "AZURE_STORAGE_KEY",
  "AZURE_STORAGE_ACCOUNT_KEY",
  "AZURE_STORAGE_SAS_TOKEN",
  "Ocp-Apim-Subscription-Key",
  "x-functions-key",
  "x-api-key",
  "api[-_]?key",
  "access[-_]?token",
  "client-certificate-data",
  "client-key-data",
  "client-?secret",
  "(?:[a-z0-9_]+_)?client_secret",
  "gh_token",
  "gitlab_token",
  "private-token",
  "job-token",
  "id-token",
  "password",
  "refresh-?token",
  "token",
].join("|");
const secretField = new RegExp(`^(?:${fields})$`, "iu");
const quotedValue = String.raw`"(?:\\.|[^"\\\r\n])*"|'(?:\\.|''|[^'\\\r\n])*'`;
const tokenValue = "[a-zA-Z0-9._~+/%-]+={0,2}";
function label(names: string, separator: string): string {
  return String.raw`(?<![\w$.-])(?:"${names}"|'${names}'|${names})[ \t]*${separator}[ \t]*`;
}

const modelAssignments = [
  new RegExp(
    `(${label("(?:AccountKey|SharedAccessKey|sig)", "=")})(${quotedValue}|${tokenValue})`,
    "gi",
  ),
  new RegExp(
    `(${label("(?:client-key-data|client-certificate-data)", ":")})(${quotedValue}|${tokenValue})`,
    "g",
  ),
];
const journalAssignments = new RegExp(
  `(${label(`(?:${fields})`, "[:=]")})(${quotedValue}|${tokenValue})`,
  "giu",
);
const authorization = /^(?:proxy-)?authorization$/i;
const scheme = /^(?:Basic|Bearer|Token)[ \t]+/i;
function authorizationHeader(separator: string): RegExp {
  const name = label("(?:proxy-)?authorization", separator);
  const value = `${quotedValue}|(?:Basic|Bearer|Token)[ \\t]+(?:${quotedValue}|${tokenValue})`;
  return new RegExp(`(${name})(${value})`, "gi");
}
const modelHeader = authorizationHeader(":");
const journalHeader = authorizationHeader("[:=]");
const tokenCharacters = new RegExp(`^${tokenValue}$`);
const gitHub = /(?:gh[pousr]_[a-z0-9]{36,}|github_pat_[a-z0-9_]{22,})/gi;
const gitLab = /gl(?:pat|oas|dt|rt|cbt|ft|imt|ptt|agent|soat|ffct|scim|wt)-[a-z0-9_-]{16,}/gi;
const privateKeyStart = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----/;
function privateKeyPattern(end: string): RegExp {
  return new RegExp(String.raw`${privateKeyStart.source}[\s\S]*?${end}`, "g");
}
const privateKeyEnd = String.raw`-----END \1-----`;
const pemLineEnd = String.raw`(?:\r\n|\r|\n|\\r\\n|\\r|\\n)`;
const privateKeyBlock = new RegExp(
  String.raw`${privateKeyStart.source}[ \t]*${pemLineEnd}[\s\S]*?${pemLineEnd}[ \t]*${privateKeyEnd}`,
  "g",
);
const journalPrivateKey = privateKeyPattern(`(?:${privateKeyEnd}|$)`);
function azureConnection(key: string): RegExp {
  return new RegExp(
    String.raw`(?<![\w-])(?:DefaultEndpointsProtocol|Endpoint|AccountEndpoint|HostName)=[^;\s"'<>]+;(?:[\w.-]+=[^;\r\n"'<>]*;){0,12}?(?:${key})=[^;\s"'<>]+;?(?:[\w.-]+=[^;\s"'<>]+;?)*`,
    "gi",
  );
}
const modelConnection = azureConnection("AccountKey|SharedAccessKey");
const journalConnection = azureConnection("AccountKey|SharedAccessKey|SharedAccessSignature");

const yamlField = /^([ \t]*(?:-[ \t]+)?)([\w-]+)[ \t]*:[ \t]*/;
const blockIndicator = /^[|>](?:[+-]?[1-9]?|[1-9][+-]?)[ \t]*(?:#.*)?$/;
const kubeDataField = /^client-(?:certificate|key)-data$/;
const kubeToken = new RegExp(`([,{][ \t\r\n]*"token"[ \t\r\n]*:[ \t\r\n]*)(${quotedValue})`, "g");
const jsonKubeUser = /"user"\s*:\s*\{(?:[^{}"\\]|"(?:\\.|[^"\\])*")*\}/g;
const kubeUser = /^([ \t]*(?:-[ \t]+)?)user[ \t]*:[ \t]*(?:#.*)?$/;
const spacedPassword = /^[^\s[\]{}()<>;,"'`|&\\]+(?:[ \t]+[^\s[\]{}()<>;,"'`|&\\]+)+$/u;
const outputPrefix =
  /^(?:\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?(?:[ \t]+(?:TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL))?[ \t]|[ \t]*\d+\t|(?:(?:[a-z]:)?[^:\r\n]+:)?\d+:|[+-]|> )/i;

type SecretSpan = [start: number, end: number];
type Scan = (start: number, end: number) => void;

function quoteWidth(value: string): number {
  const first = value.charAt(0);
  return value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first) ? 1 : 0;
}

function isCredential(value: string, minimum: number): boolean {
  return quoteWidth(value)
    ? value.length > 2
    : value.length >= minimum && tokenCharacters.test(value);
}

function scanScalar(collect: Scan, offset: number, value: string): void {
  const quote = quoteWidth(value);
  collect(offset + quote, offset + value.length - quote);
}

function scanAssignments(collect: Scan, output: string, pattern: RegExp, minimum: number): void {
  for (const match of output.matchAll(pattern)) {
    const [prefix = "", value = ""] = match.slice(1);
    if (isCredential(value, minimum)) scanScalar(collect, match.index + prefix.length, value);
  }
}

function scanAuthorization(collect: Scan, offset: number, value: string): void {
  const prefix = scheme.exec(value)?.[0];
  if (prefix) scanScalar(collect, offset + prefix.length, value.slice(prefix.length));
}

function scanHeaders(collect: Scan, output: string, pattern: RegExp): void {
  for (const match of output.matchAll(pattern)) {
    const [prefix = "", value = ""] = match.slice(1);
    // Only headers whose whole value is quoted have an opening quote before the scheme.
    const quote = quoteWidth(value);
    scanAuthorization(
      collect,
      match.index + prefix.length + quote,
      value.slice(quote, value.length - quote),
    );
  }
}

function maskSpans(output: string, spans: SecretSpan[]): string {
  if (!spans.length) return output;
  spans.sort(([left], [right]) => left - right);
  const pieces: string[] = [];
  let cursor = 0;
  for (const [start, end] of spans) {
    if (start >= cursor) pieces.push(output.slice(cursor, start), marker);
    cursor = Math.max(cursor, end);
  }
  pieces.push(output.slice(cursor));
  return pieces.join("");
}

function splitPrefix(line: string): [prefix: string, content: string] {
  const prefix = outputPrefix.exec(line)?.[0] ?? "";
  return [prefix, line.slice(prefix.length)];
}

function journalMultilineStarts(line: string): boolean {
  if (privateKeyStart.test(line)) return true;
  const [, content] = splitPrefix(line);
  if (kubeUser.test(content)) return true;
  const field = yamlField.exec(content);
  return Boolean(
    field &&
      secretField.test(field[2] ?? "") &&
      blockIndicator.test(content.slice(field[0].length)),
  );
}

function scanYaml(collect: Scan, output: string, journal: boolean): void {
  if (!output.includes(":")) return;
  let block: { indent: number; numbered: boolean } | undefined;
  let userIndent: number | undefined;
  for (const line of output.matchAll(/[^\r\n]+/g)) {
    const raw = line[0];
    const [prefix, content] = splitPrefix(raw);
    if (!content.trim()) continue;
    const indent = /^[ \t]*/.exec(content)?.[0].length ?? 0;
    if (block) {
      const rawIndent = /^[ \t]*/.exec(raw)?.[0].length ?? 0;
      if (!(block.numbered && prefix.endsWith("\t")) && rawIndent > block.indent) {
        collect(line.index + rawIndent, line.index + raw.length);
        continue;
      }
      const diffLine = prefix === "+" || prefix === "-";
      if (indent > block.indent && (!diffLine || block.indent > 0)) {
        collect(line.index + prefix.length + indent, line.index + raw.length);
        continue;
      }
      block = undefined;
    }
    if (userIndent !== undefined && indent <= userIndent) userIndent = undefined;
    const user = kubeUser.exec(content);
    if (user) userIndent = user[1]?.length;
    const field = yamlField.exec(content);
    if (!field) continue;
    const [matchedLabel, keyIndent = "", key = ""] = field;
    const value = content.slice(matchedLabel.length);
    const kubeUserToken = key === "token" && userIndent !== undefined;
    const credential = journal ? secretField.test(key) : kubeDataField.test(key) || kubeUserToken;
    if (credential && blockIndicator.test(value)) {
      block = { indent: keyIndent.length, numbered: prefix.endsWith("\t") };
    } else if ((journal && key.toLowerCase() === "password") || kubeUserToken) {
      const comment = value.search(/[ \t]#/);
      const scalar = (comment < 0 ? value : value.slice(0, comment)).trimEnd();
      if (kubeUserToken ? isCredential(scalar, 1) : spacedPassword.test(scalar)) {
        scanScalar(collect, line.index + prefix.length + matchedLabel.length, scalar);
      }
    }
  }
}

const assistantBufferLimit = 1024 * 1024;

function assistantText(
  redact: (text: string) => string,
  hasMultilineSecret: boolean,
): AssistantText {
  let tail = "";
  let holdToEnd = hasMultilineSecret;
  let overflow = false;
  return {
    push(delta) {
      if (overflow) return "";
      const hasLineEnd = /[\r\n]/.test(delta) || tail.endsWith("\r");
      tail += delta;
      let boundary = 0;
      if (!holdToEnd && hasLineEnd) {
        // Keep complete lines too when the next line can carry part of a PEM or YAML credential.
        const lineEnd = /\r\n|\n|\r(?!$)/g;
        for (const end of tail.matchAll(lineEnd)) {
          const line = tail.slice(boundary, end.index);
          if (journalMultilineStarts(line)) {
            holdToEnd = true;
            break;
          }
          boundary = end.index + end[0].length;
        }
      }
      const ready = tail.slice(0, boundary);
      tail = tail.slice(boundary);
      if (tail.length > assistantBufferLimit) {
        tail = "";
        overflow = true;
      }
      return ready ? redact(ready) : "";
    },
    remaining: () => (overflow ? marker : redact(tail)),
  };
}

/** Build both profiles from the same exact, case-sensitive host-known values. */
export function createToolOutputRedactor(knownSecrets: Iterable<string> = []): {
  journal: JournalOutputRedactor;
  model: ToolOutputRedactor;
} {
  const values = [...new Set(knownSecrets)].filter(Boolean).sort((a, b) => b.length - a.length);
  const literals = values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const known = literals.length ? new RegExp(`(?=(${literals.join("|")}))`, "g") : undefined;

  function profile(journal: boolean): ToolOutputRedactor {
    const shapes = [
      journal ? journalPrivateKey : privateKeyBlock,
      journal ? journalConnection : modelConnection,
      gitHub,
      gitLab,
    ];
    const header = journal ? journalHeader : modelHeader;

    function redact(output: string, authorizationField = false): string {
      const spans: SecretSpan[] = [];
      const collect: Scan = (start, end) => {
        if (start < end) spans.push([start, end]);
      };
      if (known) {
        for (const match of output.matchAll(known)) {
          collect(match.index, match.index + (match[1]?.length ?? 0));
        }
      }
      for (const shape of shapes) {
        for (const match of output.matchAll(shape))
          collect(match.index, match.index + match[0].length);
      }
      scanYaml(collect, output, journal);
      for (const assignment of modelAssignments) scanAssignments(collect, output, assignment, 1);
      scanHeaders(collect, output, header);
      if (journal) scanAssignments(collect, output, journalAssignments, 16);
      else {
        for (const user of output.matchAll(jsonKubeUser)) {
          scanAssignments(
            (start, end) => collect(user.index + start, user.index + end),
            user[0],
            kubeToken,
            1,
          );
        }
      }
      if (authorizationField) scanAuthorization(collect, 0, output);
      return maskSpans(output, spans);
    }

    const text = (output: string) => redact(output);

    function value(output: JsonValue, inKubeUser = false): JsonValue {
      if (typeof output === "string") return text(output);
      if (output === null || typeof output !== "object") return output;
      if (Array.isArray(output)) return output.map((item) => value(item));
      return Object.fromEntries(
        Object.entries(output).map(([key, field]) => {
          const credential = journal
            ? secretField.test(key) || key.toLowerCase() === "sig"
            : kubeDataField.test(key) || (inKubeUser && key === "token");
          let sanitized: JsonValue;
          if (typeof field === "string" && field && credential) sanitized = marker;
          else if (typeof field === "string" && authorization.test(key))
            sanitized = redact(field, true);
          else sanitized = value(field, key === "user");
          return [text(key), sanitized];
        }),
      );
    }

    return { text, value, chunks: (output) => text(Array.from(output).join("")) };
  }

  const journal = profile(true);
  const hasMultilineSecret = values.some((value) => /[\r\n]/.test(value));
  return {
    journal: { ...journal, assistantText: () => assistantText(journal.text, hasMultilineSecret) },
    model: profile(false),
  };
}

const defaults = createToolOutputRedactor();
/** Strict redaction for ThreadEngine's SQLite journal. */
export const journalOutputRedactor = defaults.journal;
/** Precise redaction the host must use for model-bound tool results. */
export const modelOutputRedactor = defaults.model;
