// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CommitIdentity } from "../scopes/git.js";

type UserFields = { name?: string; email?: string };

function unquote(raw: string): string {
  let value = "";
  let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === "#" || char === ";")) break;
    else if (char === "\\") {
      const next = raw[++index];
      value += next === "n" ? "\n" : next === "t" ? "\t" : (next ?? "");
    } else value += char;
  }
  return value.trim();
}

/** The `[user]` name and email of one git config file; includes are not followed. */
export function parseUserIdentity(text: string): UserFields {
  const found: UserFields = {};
  let inUser = false;
  for (const line of text.split(/\r?\n/u)) {
    const section = /^\s*\[([^\]]*)\]\s*(.*)$/u.exec(line);
    let body = line;
    if (section) {
      inUser = (section[1] ?? "").trim().toLowerCase() === "user";
      body = section[2] ?? "";
    }
    if (!inUser) continue;
    const entry = /^\s*([A-Za-z][\w-]*)\s*(?:=(.*))?$/u.exec(body);
    if (!entry || entry[2] === undefined) continue;
    const key = (entry[1] ?? "").toLowerCase();
    const value = unquote(entry[2]);
    if (key !== "name" && key !== "email") continue;
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
