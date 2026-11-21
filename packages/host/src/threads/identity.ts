// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CommitIdentity } from "../scopes/git.js";

type UserFields = { name?: string; email?: string };

const escapes: Record<string, string> = { n: "\n", t: "\t", b: "\b", "\\": "\\", '"': '"' };

/** One value as git reads it, from `rest` on line `at` through any continued lines. */
function readValue(lines: string[], at: number, rest: string): { value?: string; last: number } {
  let value = "";
  let quoted = false;
  let spaces = "";
  let line = rest;
  let index = at;
  for (let column = 0; column < line.length; column += 1) {
    const char = line[column] ?? "";
    if (!quoted && /\s/u.test(char)) {
      if (value) spaces += " ";
      continue;
    }
    if (!quoted && (char === "#" || char === ";")) break;
    value += spaces;
    spaces = "";
    if (char === '"') quoted = !quoted;
    else if (char !== "\\") value += char;
    else if (column === line.length - 1) {
      if (index + 1 >= lines.length) break;
      index += 1;
      line = lines[index] ?? "";
      column = -1;
    } else {
      column += 1;
      const escaped = escapes[line[column] ?? ""];
      if (escaped === undefined) return { last: index };
      value += escaped;
    }
  }
  return quoted ? { last: index } : { value, last: index };
}

/** The `[user]` name and email of one git config file; includes are not followed. */
export function parseUserIdentity(text: string): UserFields {
  const found: UserFields = {};
  const lines = text.split(/\r?\n/u);
  let inUser = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const section = /^\s*\[([^\]]*)\]\s*(.*)$/u.exec(line);
    let body = line;
    if (section) {
      inUser = (section[1] ?? "").trim().toLowerCase() === "user";
      body = section[2] ?? "";
    }
    const entry = /^\s*([A-Za-z][\w-]*)\s*(?:=(.*))?$/u.exec(body);
    if (!entry || entry[2] === undefined) continue;
    const { value, last } = readValue(lines, index, entry[2]);
    index = last;
    const key = (entry[1] ?? "").toLowerCase();
    if (!inUser || (key !== "name" && key !== "email")) continue;
    if (value) found[key] = value;
    else delete found[key];
  }
  return found;
}

async function readUser(path: string): Promise<UserFields> {
  try {
    return parseUserIdentity(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

/** The operator's own name and email from their global git config, read as files; git is not run. */
export async function operatorIdentity(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<CommitIdentity | undefined> {
  const xdg =
    env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME
      : join(home, ".config");
  const global = await readUser(join(home, ".gitconfig"));
  const fallback = await readUser(join(xdg, "git", "config"));
  const name = global.name ?? fallback.name;
  const email = global.email ?? fallback.email;
  return name && email ? { name, email } : undefined;
}
