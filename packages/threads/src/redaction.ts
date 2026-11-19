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
const credentialFields = [
  "AccountKey",
  "SharedAccessKey",
  "SharedAccessSignature",
  "AZURE_CLIENT_SECRET",
  "AZURE_OPENAI_API_KEY",
  "AZURE_API_KEY",
  "AZURE_STORAGE_KEY",
  "AZURE_STORAGE_ACCOUNT_KEY",
  "AZURE_STORAGE_SAS_TOKEN",
  "Ocp-Apim-Subscription-Key",
  "x-functions-key",
  "api-key",
  "apiKey",
  "access-token",
  "accessToken",
  "client-certificate-data",
  "client-key-data",
  "client-secret",
  "clientSecret",
  "id-token",
  "password",
  "refresh-token",
  "refreshToken",
  "token",
];
const credentialFieldNames = new Set(credentialFields.map((field) => field.toLowerCase()));
const fields = credentialFields.join("|");
const quotedValue = String.raw`"(?:\\.|[^"\\\r\n])*"|'(?:''|[^'\r\n])*'`;
const unquotedValue = String.raw`[^\s"'<>;,{}[\]|]+`;
const assignment = new RegExp(
  String.raw`((?<![\w-])(?:["']?(?:${fields})["']?)[ \t]*[:=][ \t]*)(${quotedValue}|${unquotedValue})`,
  "giu",
);
const yamlBlock = new RegExp(
  String.raw`^([ \t]*)((?:${fields})[ \t]*:[ \t]*[|>][1-9+-]{0,2}[ \t]*(?:#[^\r\n]*)?\r?\n(?:[ \t]*\r?\n)*)(\1[ \t]+)[^\r\n]*(?:(?:\r?\n[ \t]*(?=\r?\n))*\r?\n\1[ \t]+[^\r\n]*)*`,
  "gimu",
);
const yamlValue = new RegExp(
  String.raw`^([ \t]*(?:-[ \t]+)?(?:${fields})[ \t]*:[ \t]*)([^\s#|>][^\r\n]*)`,
  "gimu",
);
const yamlQuotedValue = new RegExp(`^(?:${quotedValue})`, "u");
const authorization = /^(?:proxy-)?authorization$/i;
const bearer = /^(Bearer[ \t]+)[a-z0-9._~+/-]+=*/i;
const bearerHeader =
  /((?<![\w-])["']?(?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["']?Bearer[ \t]+)[a-z0-9._~+/-]+=*/gi;
const gitHub = /(?<![\w])(?:gh[pousr]_[a-z0-9]{36,}|github_pat_[a-z0-9_]{22,})/gi;
const gitLab =
  /(?<![\w])gl(?:pat|oas|dt|rt|cbt|ft|imt|ptt|agent|soat|ffct|scim|wt)-[a-z0-9_-]{16,}/gi;
const privateKey =
  /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?(?:-----END \1-----|$)/g;
const azureConnection =
  /(?<![\w-])(?:DefaultEndpointsProtocol|Endpoint|AccountEndpoint|HostName)=[^;\s"'<>]+;(?:[\w.-]+=[^;\r\n"'<>]*;){0,12}?(?:AccountKey|SharedAccessKey|SharedAccessSignature)=[^;\s"'<>]+;?(?:[\w.-]+=[^;\s"'<>]+;?)*/gi;

function maskValue(match: string, prefix: string, value: string): string {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    return value.length === 2 ? match : prefix + quote + marker + quote;
  }
  return /^(?:null|~)$/i.test(value) ? match : prefix + marker;
}

function maskYamlValue(_match: string, prefix: string, line: string): string {
  const comment = line.search(/[ \t]#/);
  const value =
    yamlQuotedValue.exec(line)?.[0] ?? line.slice(0, comment < 0 ? line.length : comment).trimEnd();
  return maskValue(prefix + value, prefix, value) + line.slice(value.length);
}

function redactText(output: string): string {
  return output
    .replace(privateKey, marker)
    .replace(azureConnection, marker)
    .replace(yamlBlock, "$1$2$3[redacted]")
    .replace(yamlValue, maskYamlValue)
    .replace(assignment, maskValue)
    .replace(bearerHeader, "$1[redacted]")
    .replace(gitHub, marker)
    .replace(gitLab, marker);
}

function redactField(key: string, value: JsonValue): JsonValue {
  if (typeof value === "string" && value) {
    if (credentialFieldNames.has(key.toLowerCase())) return marker;
    if (authorization.test(key)) return redactText(value.replace(bearer, "$1[redacted]"));
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

export const toolOutputRedactor: ToolOutputRedactor = {
  text: redactText,
  value: redactValue,
  chunks: (output) => redactText(Array.from(output).join("")),
};
