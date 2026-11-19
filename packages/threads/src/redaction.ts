// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { JsonValue } from "./types.js";

export interface ToolOutputRedactor {
  text(output: string): string;
  value(output: JsonValue): JsonValue;
  /** Buffer one complete output in order. Only the returned text is safe to forward. */
  chunks(output: Iterable<string>): string;
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
const credentialField = new RegExp(`^(?:${fields}|sig)$`, "iu");
const quotedValue = String.raw`"(?:\\.|[^"\\\r\n])*"|'(?:\\.|''|[^'\\\r\n])*'`;
const bareValue = String.raw`[^\s"'<>;,{}[\]|()&]+`;
function label(names: string, separator: string): string {
  return String.raw`(?<![\w$.-])(?:"(?:${names})"|'(?:${names})'|(?:${names}))[ \t]*${separator}[ \t]*`;
}
const assignment = new RegExp(
  `((?:${label(fields, "[:=]")}|${label("sig", "=")}))(${quotedValue}|${bareValue})`,
  "giu",
);
const authorization = /^(?:proxy-)?authorization$/i;
const scheme = /^(?:Basic|Bearer|Token)[ \t]+/i;
const header = new RegExp(
  String.raw`(${label("(?:proxy-)?authorization", "[:=]")})(${quotedValue}|(?:Basic|Bearer|Token)[ \t]+(?:${quotedValue}|${bareValue}))`,
  "giu",
);
const opaqueMinLength = 16;
const tokenCharacters = /^[a-z0-9._~+/%-]+={0,2}$/i;
const identifier = String.raw`[$_\p{ID_Start}][$\p{ID_Continue}\u200c\u200d]*`;
const identifierOrMember = new RegExp(String.raw`^${identifier}(?:\.${identifier})*\.?$`, "u");
const quotedValueSuffix = /^["'%\p{ID_Continue}]/u;
const expressionSuffix = /^[ \t]*(?:\(|\[|\?\.|\.[a-z_$]|\+|=(?:=|>))/i;
const gitHub = /(?:gh[pousr]_[a-z0-9]{36,}|github_pat_[a-z0-9_]{22,})/gi;
const gitLab = /gl(?:pat|oas|dt|rt|cbt|ft|imt|ptt|agent|soat|ffct|scim|wt)-[a-z0-9_-]{16,}/gi;
const privateKey =
  /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?(?:-----END \1-----|$)/g;
const azureConnection =
  /(?<![\w-])(?:DefaultEndpointsProtocol|Endpoint|AccountEndpoint|HostName)=[^;\s"'<>]+;(?:[\w.-]+=[^;\r\n"'<>]*;){0,12}?(?:AccountKey|SharedAccessKey|SharedAccessSignature)=[^;\s"'<>]+;?(?:[\w.-]+=[^;\s"'<>]+;?)*/gi;

const yamlLabel = new RegExp(String.raw`^([ \t]*(?:-[ \t]+)?)(${fields})[ \t]*:[ \t]*`, "iu");
const blockIndicator = /^[|>](?:[+-]?[1-9]?|[1-9][+-]?)[ \t]*(?:#.*)?$/;
const kubeDataField = /^client-(?:certificate|key)-data$/i;
const yamlUserField = /^[ \t]*(?:-[ \t]+)?(?:users?|username)[ \t]*:/i;
const spacedPassword = /^[^\s[\]{}()<>;,"'`|&\\]+(?:[ \t]+[^\s[\]{}()<>;,"'`|&\\]+)+$/u;
const expressionKeyword = /^(?:await|new|typeof|keyof|void|delete|yield|infer|readonly)[ \t]/;
const outputPrefix =
  /^(?:\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?(?:[ \t]+(?:TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL))?[ \t]|[ \t]*\d+\t|(?:(?:[a-z]:)?[^:\r\n]+:)?\d+:|[+-]|> )/i;

function quoteOf(value: string): string {
  return (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
    ? value.charAt(0)
    : "";
}

function isOpaque(value: string): boolean {
  return (
    value.length >= opaqueMinLength &&
    tokenCharacters.test(value) &&
    !identifierOrMember.test(value) &&
    Number.isNaN(Number(value.replaceAll("_", "")))
  );
}

function isQuotedCredential(label: string, value: string): boolean {
  if (!value) return false;
  if (label.toLowerCase() !== "token") return true;
  // The generic token label also names display text and abbreviated Git object IDs.
  return !/\s/.test(value) && !/^[a-f0-9]{7,12}$/i.test(value);
}

function maskAssignment(
  match: string,
  prefix: string,
  value: string,
  offset: number,
  output: string,
): string {
  const tail = output.slice(offset + match.length);
  if (expressionSuffix.test(tail)) return match;
  const quote = quoteOf(value);
  const key = prefix.replace(/["' \t:=]/g, "");
  if (
    quote
      ? !quotedValueSuffix.test(tail) && isQuotedCredential(key, value.slice(1, -1))
      : isOpaque(value)
  ) {
    return prefix + quote + marker + quote;
  }
  return match;
}

function maskAuthorization(value: string, quoted: boolean): string {
  const prefix = scheme.exec(value)?.[0];
  if (!prefix) return value;
  const key = value.slice(prefix.length);
  const quote = quoteOf(key);
  if (quote ? key.length > 2 : key && (quoted || isOpaque(key))) {
    return prefix + quote + marker + quote;
  }
  return value;
}

function maskHeader(
  match: string,
  prefix: string,
  value: string,
  offset: number,
  output: string,
): string {
  const tail = output.slice(offset + match.length);
  const quote = quoteOf(value);
  const hasClosingQuote = /["']$/.test(value);
  if (expressionSuffix.test(tail) || (hasClosingQuote && quotedValueSuffix.test(tail)))
    return match;
  const contents = quote ? value.slice(1, -1) : value;
  return prefix + quote + maskAuthorization(contents, Boolean(quote)) + quote;
}

function splitPrefix(line: string): [prefix: string, content: string] {
  const prefix = outputPrefix.exec(line)?.[0] ?? "";
  return [prefix, line.slice(prefix.length)];
}

function redactYaml(output: string): string {
  if (!output.includes(":")) return output;
  const lines = output.split(/(\r\n|\n|\r)/);
  let blockIndent: number | undefined;
  for (let index = 0; index < lines.length; index += 2) {
    const [prefix, content] = splitPrefix(lines[index] ?? "");
    const indent = /^[ \t]*/.exec(content)?.[0] ?? "";
    if (blockIndent !== undefined) {
      if (!content.trim()) continue;
      if (indent.length > blockIndent) {
        lines[index] = prefix + indent + marker;
        continue;
      }
      blockIndent = undefined;
    }
    const field = yamlLabel.exec(content);
    if (!field) continue;
    const [matchedLabel, keyIndent = "", key = ""] = field;
    const value = content.slice(matchedLabel.length);
    const isBlock = blockIndicator.test(value);
    if (!isBlock && key.toLowerCase() !== "password") continue;
    const adjacent = [lines[index - 2], lines[index + 2]].some(
      (line) => line !== undefined && yamlUserField.test(splitPrefix(line)[1]),
    );
    if (isBlock) {
      if (kubeDataField.test(key) || adjacent) blockIndent = keyIndent.length;
    } else {
      // A kubeconfig excerpt can carry a plain YAML scalar with spaces.
      if (!prefix && !(indent && adjacent)) continue;
      const comment = value.search(/[ \t]#/);
      const scalar = (comment < 0 ? value : value.slice(0, comment)).trimEnd();
      if (spacedPassword.test(scalar) && !expressionKeyword.test(scalar)) {
        lines[index] = prefix + matchedLabel + marker + value.slice(scalar.length);
      }
    }
  }
  return lines.join("");
}

export function createToolOutputRedactor(knownSecrets: Iterable<string> = []): ToolOutputRedactor {
  const values = [...new Set(knownSecrets)].filter(Boolean).sort((a, b) => b.length - a.length);
  const known = values.length
    ? new RegExp(values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g")
    : undefined;

  function replaceKnown(output: string): string {
    return known ? output.replace(known, marker) : output;
  }

  function redactPatterns(output: string): string {
    return redactYaml(output.replace(privateKey, marker).replace(azureConnection, marker))
      .replace(assignment, maskAssignment)
      .replace(header, maskHeader)
      .replace(gitHub, marker)
      .replace(gitLab, marker);
  }

  function redactText(output: string): string {
    return redactPatterns(replaceKnown(output));
  }

  function redactField(key: string, value: JsonValue): JsonValue {
    if (typeof value === "string" && value) {
      if (credentialField.test(key) && isQuotedCredential(key, value)) return marker;
      if (authorization.test(key))
        return redactPatterns(maskAuthorization(replaceKnown(value), true));
    }
    return redactValue(value);
  }

  function redactValue(output: JsonValue): JsonValue {
    if (typeof output === "string") return redactText(output);
    if (output === null || typeof output !== "object") return output;
    if (Array.isArray(output)) return output.map(redactValue);
    return Object.fromEntries(
      Object.entries(output).map(([key, value]) => [redactText(key), redactField(key, value)]),
    );
  }

  return {
    text: redactText,
    value: redactValue,
    chunks: (output) => redactText(Array.from(output).join("")),
  };
}

export const toolOutputRedactor = createToolOutputRedactor();
