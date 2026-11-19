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
  flush(): string;
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

const placeholderValue = String.raw`(?:\$?\{[^{}\r\n]*\}|<[^<>\r\n]*>|\$[\w]+\$?)`;
const modelScalar = `${quotedValue}|${placeholderValue}|${tokenValue}`;
const kubeDataAssignment = new RegExp(
  `(${label("(?:client-key-data|client-certificate-data)", ":")})(${modelScalar})`,
  "g",
);
const journalAssignments = new RegExp(
  `(${label(`(?:${fields})`, "[:=]")})(${quotedValue}|${tokenValue})`,
  "giu",
);
const journalSignature = new RegExp(
  `(${label("(?:AccountKey|SharedAccessKey|sig)", "=")})(${quotedValue}|${tokenValue})`,
  "gi",
);
const authorization = /^(?:proxy-)?authorization$/i;
const scheme = /^(?:Basic|Bearer|Token)[ \t]+/i;
function authorizationHeader(scalar: string): RegExp {
  const name = label("(?:proxy-)?authorization", "[:=]");
  const value = `${quotedValue}|(?:Basic|Bearer|Token)[ \\t]+(?:${scalar})`;
  return new RegExp(`(${name})(${value})`, "gi");
}
const modelHeader = authorizationHeader(modelScalar);
const journalHeader = authorizationHeader(`${quotedValue}|${tokenValue}`);
const escapedHeader = new RegExp(
  String.raw`(\\+"(?:proxy-)?authorization\\+"[ \t]*:[ \t]*\\+"(?:Basic|Bearer|Token)[ \t]+)(${placeholderValue}|${tokenValue})(?=\\+")`,
  "gi",
);
const tokenCharacters = new RegExp(`^${tokenValue}$`);
const gitHub = /(?:gh[pousr]_[a-z0-9]{36,}|github_pat_[a-z0-9_]{22,})/gi;
const gitLab = /gl(?:pat|oas|dt|rt|cbt|ft|imt|ptt|agent|soat|ffct|scim|wt)-[a-z0-9_-]{16,}/gi;
const privateKeyStart = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----/;
function privateKeyPattern(end: string): RegExp {
  return new RegExp(String.raw`${privateKeyStart.source}[\s\S]*?${end}`, "g");
}
const privateKeyEnd = String.raw`-----END \1-----`;
const pemLineEnd = /\r\n|[\r\n]|\\+r\\+n|\\+[rn]/g;
const pemBody = /^[A-Za-z0-9+/]+={0,2}$/;
function privateKeyFooter(kind: string): string {
  return `-----END ${kind}-----`;
}
const journalPrivateKey = privateKeyPattern(`(?:${privateKeyEnd}|$)`);
function azureConnection(key: string): RegExp {
  return new RegExp(
    String.raw`(?<![\w-])(?:DefaultEndpointsProtocol|Endpoint|AccountEndpoint|HostName)=[^;\s"'<>]+;(?:[\w.-]+=[^;\r\n"'<>]*;){0,12}?(?:${key})=[^;\s"'<>]+;?(?:[\w.-]+=[^;\s"'<>]+;?)*`,
    "gi",
  );
}
const connectionValue = String.raw`(?:${quotedValue}|${placeholderValue}|[^;\\\s"'<>\x60]+)`;
const connectionField = String.raw`[\w.-]+=${connectionValue}`;
const modelConnection = new RegExp(
  String.raw`(?<![\w.-])${connectionField}(?:;${connectionField})+`,
  "g",
);
const connectionEntry = new RegExp(String.raw`([\w.-]+)=(${connectionValue})`, "g");
const connectionAnchors = new Set(["AccountName", "Endpoint", "DefaultEndpointsProtocol"]);
const connectionKeys = new Set(["AccountKey", "SharedAccessKey", "sig"]);
const querySignature = new RegExp(`([?&]sig=)(${modelScalar})`, "g");
const journalConnection = azureConnection("AccountKey|SharedAccessKey|SharedAccessSignature");

const yamlField = /^([ \t]*(?:-[ \t]+)?)([\w-]+)[ \t]*:[ \t]*/;
const blockIndicator = /^[|>](?:[+-]?[1-9]?|[1-9][+-]?)[ \t]*(?:#.*)?$/;
const kubeDataField = /^client-(?:certificate|key)-data$/;
const kubeToken = new RegExp(
  `([,{][ \\t\\r\\n]*(?:"token"|'token'|token)[ \\t\\r\\n]*:[ \\t\\r\\n]*)(${modelScalar})`,
  "g",
);
const flowKubeUser =
  /(?<![\w.-])(?:"user"|'user'|user)\s*:\s*\{(?:[^{}"'\\]|"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|\{[^{}]*\})*\}/g;
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

function isModelCredential(value: string): boolean {
  const quote = quoteWidth(value);
  const scalar = value.slice(quote, value.length - quote).trim();
  return scalar.length >= 8 && !modelPlaceholder.test(scalar);
}

const modelPlaceholder = new RegExp(`^(?:\\.\\.\\.|${placeholderValue})$`);

function scanAssignments(
  collect: Scan,
  output: string,
  pattern: RegExp,
  accepts: (value: string) => boolean,
): void {
  for (const match of output.matchAll(pattern)) {
    const [prefix = "", value = ""] = match.slice(1);
    if (accepts(value)) scanScalar(collect, match.index + prefix.length, value);
  }
}

function scanAuthorization(collect: Scan, offset: number, value: string, journal: boolean): void {
  const prefix = scheme.exec(value)?.[0];
  if (!prefix) return;
  const credential = value.slice(prefix.length);
  if (journal || isModelCredential(credential)) {
    scanScalar(collect, offset + prefix.length, credential);
  }
}

function scanHeaders(collect: Scan, output: string, journal: boolean): void {
  for (const match of output.matchAll(journal ? journalHeader : modelHeader)) {
    const [prefix = "", value = ""] = match.slice(1);
    // Only headers whose whole value is quoted have an opening quote before the scheme.
    const quote = quoteWidth(value);
    scanAuthorization(
      collect,
      match.index + prefix.length + quote,
      value.slice(quote, value.length - quote),
      journal,
    );
  }
  if (!journal) scanAssignments(collect, output, escapedHeader, isModelCredential);
}

function scanModelConnection(collect: Scan, output: string): void {
  if (output.includes(";")) {
    for (const match of output.matchAll(modelConnection)) {
      const fields = [...match[0].matchAll(connectionEntry)];
      if (!fields.some(([, key]) => key !== undefined && connectionAnchors.has(key))) continue;
      for (const field of fields) {
        const [, key = "", value = ""] = field;
        if (connectionKeys.has(key) && isModelCredential(value)) {
          scanScalar(collect, match.index + field.index + key.length + 1, value);
        }
      }
    }
  }
  scanAssignments(collect, output, querySignature, isModelCredential);
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

function scanModelPrivateKeys(collect: Scan, output: string): void {
  if (!privateKeyStart.test(output)) return;
  const lines: { text: string; start: number }[] = [];
  let start = 0;
  for (const end of output.matchAll(pemLineEnd)) {
    lines.push({ text: output.slice(start, end.index), start });
    start = end.index + end[0].length;
  }
  lines.push({ text: output.slice(start), start });

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line) continue;
    const header = privateKeyStart.exec(line.text);
    if (!header?.[1]) continue;
    const footer = privateKeyFooter(header[1]);
    const bodyStart = header.index + header[0].length;
    const inlineEnd = line.text.indexOf(footer, bodyStart);
    const keyStart = line.start + header.index;
    if (inlineEnd >= 0) {
      const body = line.text.slice(bodyStart, inlineEnd).trim();
      if (pemBody.test(body) && isModelCredential(body)) {
        collect(keyStart, line.start + inlineEnd + footer.length);
      }
      continue;
    }
    if (line.text.slice(bodyStart).trim()) continue;

    const [headerPrefix] = splitPrefix(line.text.slice(0, header.index));
    let end = bodyStart + line.start;
    let bodyLength = 0;
    for (let next = index + 1; next < lines.length; next++) {
      const part = lines[next];
      if (!part) break;
      // A bare footer starts with a minus too.
      const [prefix, content] = part.text.trimStart().startsWith(footer)
        ? ["", part.text]
        : splitPrefix(part.text);
      const body = content.trim();
      if (body.startsWith(footer)) {
        if (bodyLength >= 8) {
          collect(keyStart, part.start + prefix.length + content.indexOf(footer) + footer.length);
          index = next;
        }
        break;
      }
      if ((!prefix && headerPrefix) || (body && !pemBody.test(body))) {
        if (bodyLength || !/^(?:Proc-Type|DEK-Info|Version|Comment):/.test(body)) break;
        continue;
      }
      if (!body) continue;
      bodyLength += body.length;
      end = part.start + part.text.length;
    }
    if (bodyLength >= 8) collect(keyStart, end);
  }
}

interface YamlBlock {
  indent: number;
  numbered: boolean;
}

function indentation(line: string): number {
  return /^[ \t]*/.exec(line)?.[0].length ?? 0;
}

function yamlBodyOffset(raw: string, prefix: string, indent: number, block: YamlBlock): number {
  const rawIndent = indentation(raw);
  if (!(block.numbered && prefix.endsWith("\t")) && rawIndent > block.indent) return rawIndent;
  const diffLine = prefix === "+" || prefix === "-";
  return indent > block.indent && (!diffLine || block.indent > 0) ? prefix.length + indent : -1;
}

function scanYaml(collect: Scan, output: string, journal: boolean): void {
  if (!output.includes(":")) return;
  let block: YamlBlock | undefined;
  let userIndent: number | undefined;
  for (const line of output.matchAll(/[^\r\n]+/g)) {
    const raw = line[0];
    const [prefix, content] = splitPrefix(raw);
    if (!content.trim()) continue;
    const indent = indentation(content);
    if (block) {
      const offset = yamlBodyOffset(raw, prefix, indent, block);
      if (offset >= 0) {
        if (journal || isModelCredential(raw.slice(offset))) {
          collect(line.index + offset, line.index + raw.length);
        }
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
      if (
        kubeUserToken
          ? isCredential(scalar, 1) && (journal || isModelCredential(scalar))
          : spacedPassword.test(scalar)
      ) {
        scanScalar(collect, line.index + prefix.length + matchedLabel.length, scalar);
      }
    }
  }
}

const assistantBufferLimit = 16 * 1024;
const assistantLineEnd = /\r\n|\n|\r(?!$)/g;
type AssistantBlock = { footer: string } | { yaml: YamlBlock } | { userIndent: number };

function assistantBlock(line: string): AssistantBlock | undefined {
  for (const match of line.matchAll(journalPrivateKey)) {
    if (match[1]) {
      const footer = privateKeyFooter(match[1]);
      if (!match[0].endsWith(footer)) return { footer };
    }
  }
  const [prefix, content] = splitPrefix(line);
  const user = kubeUser.exec(content);
  if (user?.[1] !== undefined) return { userIndent: user[1].length };
  const field = yamlField.exec(content);
  if (field?.[1] === undefined || !secretField.test(field[2] ?? "")) return undefined;
  if (!blockIndicator.test(content.slice(field[0].length))) return undefined;
  return { yaml: { indent: field[1].length, numbered: prefix.endsWith("\t") } };
}

function yamlContinues(block: Exclude<AssistantBlock, { footer: string }>, line: string): boolean {
  const [prefix, content] = splitPrefix(line);
  const indent = indentation(content);
  if (!content.trim()) return true;
  return "yaml" in block
    ? yamlBodyOffset(line, prefix, indent, block.yaml) >= 0
    : indent > block.userIndent;
}

function assistantLines(output: string, flush: boolean) {
  let ready = 0;
  let start = 0;
  let block: AssistantBlock | undefined;
  function scan(end: number, next: number): void {
    const line = output.slice(start, end);
    if (block && "footer" in block) {
      const close = line.indexOf(block.footer);
      if (close >= 0) block = assistantBlock(line.slice(close + block.footer.length));
    } else if (!block || !yamlContinues(block, line)) {
      ready = start;
      block = assistantBlock(line);
    }
    if (!block) ready = next;
    start = next;
  }
  for (const end of output.matchAll(assistantLineEnd)) scan(end.index, end.index + end[0].length);
  if (flush && start < output.length) scan(output.length, output.length);
  return { ready, block };
}

function beforeLine(output: string, offset: number): number {
  const start = output[offset] === "\n" && output[offset - 1] === "\r" ? offset - 1 : offset;
  if (start === 0) return 0;
  return 1 + Math.max(output.lastIndexOf("\n", start - 1), output.lastIndexOf("\r", start - 1));
}

function assistantText(
  redact: (text: string) => string,
  multilineSecrets: string[],
  knownMultiline: RegExp | undefined,
): AssistantText {
  let tail = "";
  let discardBlock: AssistantBlock | undefined;
  let discardLine = false;
  let discardLiterals: string[] = [];

  function discard(delta: string, flush: boolean): string {
    if (discardLiterals.length) {
      let consumed = 0;
      const remaining = [];
      for (const literal of discardLiterals) {
        let length = 0;
        while (
          length < literal.length &&
          length < delta.length &&
          literal[length] === delta[length]
        ) {
          length++;
        }
        consumed = Math.max(consumed, length);
        if (length === delta.length && length < literal.length)
          remaining.push(literal.slice(length));
      }
      discardLiterals = remaining;
      delta = delta.slice(consumed);
    }
    let start = 0;
    for (const end of delta.matchAll(assistantLineEnd)) {
      if (!discardLine && !discardBlock) break;
      const line = delta.slice(start, end.index);
      if (discardBlock && "footer" in discardBlock) {
        const close = line.indexOf(discardBlock.footer);
        if (close >= 0) {
          start += close + discardBlock.footer.length;
          discardBlock = undefined;
          discardLine = false;
          break;
        }
      } else if (!discardLine && discardBlock && !yamlContinues(discardBlock, line)) {
        discardBlock = undefined;
        break;
      }
      start = end.index + end[0].length;
      discardLine = false;
    }
    if (discardLine) return "";
    const rest = delta.slice(start);
    if (!discardBlock || !flush) return rest;
    if ("footer" in discardBlock) {
      const end = rest.indexOf(discardBlock.footer);
      if (end < 0) return "";
      const suffix = rest.slice(end + discardBlock.footer.length);
      discardBlock = undefined;
      return suffix;
    }
    if (yamlContinues(discardBlock, rest)) return "";
    discardBlock = undefined;
    return rest;
  }

  function take(delta: string, flush: boolean): string {
    tail += delta;
    if (discardBlock || discardLine || discardLiterals.length) {
      tail = discard(tail, flush);
      if (discardBlock) {
        if (tail.length > assistantBufferLimit) {
          tail = "";
          discardLine = true;
        }
        return "";
      }
    }

    let partialStart = tail.length;
    const partials: string[] = [];
    for (const value of multilineSecrets) {
      const head = value.split(/[\r\n]/, 1)[0] ?? "";
      for (
        let start = tail.indexOf(head, Math.max(0, tail.length - value.length + 1));
        start >= 0 && start < tail.length;
        start = tail.indexOf(head, start + 1)
      ) {
        const suffix = tail.slice(start);
        if (!value.startsWith(suffix)) continue;
        partialStart = Math.min(partialStart, start);
        partials.push(value.slice(suffix.length));
      }
    }

    const ceiling = !flush && partials.length ? beforeLine(tail, partialStart) : tail.length;
    const matches = knownMultiline ? [...tail.matchAll(knownMultiline)].reverse() : [];
    let { ready, block } = assistantLines(tail.slice(0, ceiling), flush);
    while (!flush) {
      const lineBoundary = ready;
      for (const match of matches) {
        if (match.index < ready && match.index + (match[1]?.length ?? 0) > ready) {
          ready = beforeLine(tail, match.index);
        }
      }
      if (ready === lineBoundary) break;
      ({ ready } = assistantLines(tail.slice(0, ready), false));
    }
    if (flush) {
      for (const match of matches) {
        if (match.index < partialStart && match.index + (match[1]?.length ?? 0) > partialStart) {
          partialStart = match.index;
        }
      }
      const result = redact(tail.slice(0, partialStart)) + (partials.length ? marker : "");
      discardBlock = block;
      discardLine = Boolean(block && !/[\r\n]$/.test(tail));
      if (partials.length) discardLiterals = partials;
      tail = "";
      return result;
    }
    const result = redact(tail.slice(0, ready));
    tail = tail.slice(ready);
    if (tail.length <= assistantBufferLimit) return result;
    discardBlock = assistantLines(tail, true).block;
    discardLine = !/[\r\n]$/.test(tail);
    discardLiterals = partials;
    const newline = /(?:\r\n|[\r\n])$/.exec(tail)?.[0] ?? "";
    tail = "";
    return result + marker + newline;
  }

  return { push: (delta) => take(delta, false), flush: () => take("", true) };
}

/** Build both profiles from the same exact, case-sensitive host-known values. */
export function createToolOutputRedactor(knownSecrets: Iterable<string> = []): {
  journal: JournalOutputRedactor;
  model: ToolOutputRedactor;
} {
  const values = [...new Set(knownSecrets)].filter(Boolean).sort((a, b) => b.length - a.length);
  const literalPattern = (secrets: string[]) => {
    const escaped = secrets.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return escaped.length ? new RegExp(`(?=(${escaped.join("|")}))`, "g") : undefined;
  };
  const known = literalPattern(values);
  const multilineSecrets = values.filter((value) => /[\r\n]/.test(value));
  const knownMultiline = literalPattern(multilineSecrets);

  function profile(journal: boolean): ToolOutputRedactor {
    const shapes = journal
      ? [journalPrivateKey, journalConnection, gitHub, gitLab]
      : [gitHub, gitLab];

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
      scanHeaders(collect, output, journal);
      if (journal) {
        scanAssignments(collect, output, journalAssignments, (value) => isCredential(value, 16));
        scanAssignments(collect, output, kubeDataAssignment, (value) => isCredential(value, 1));
        scanAssignments(collect, output, journalSignature, (value) => isCredential(value, 1));
      } else {
        scanModelPrivateKeys(collect, output);
        scanModelConnection(collect, output);
        scanAssignments(collect, output, kubeDataAssignment, isModelCredential);
        for (const user of output.matchAll(flowKubeUser)) {
          scanAssignments(
            (start, end) => collect(user.index + start, user.index + end),
            user[0],
            kubeToken,
            isModelCredential,
          );
        }
      }
      if (authorizationField) scanAuthorization(collect, 0, output, journal);
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
          if (
            typeof field === "string" &&
            credential &&
            (journal ? field : isModelCredential(field))
          )
            sanitized = marker;
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

  return {
    journal: {
      ...journal,
      assistantText: () => assistantText(journal.text, multilineSecrets, knownMultiline),
    },
    model: profile(false),
  };
}

const defaults = createToolOutputRedactor();
/** Strict redaction for ThreadEngine's SQLite journal. */
export const journalOutputRedactor = defaults.journal;
/** Precise redaction the host must use for model-bound tool results. */
export const modelOutputRedactor = defaults.model;
