// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  auditSweep,
  FENCE_MARK,
  JWT_MARK,
  references,
  scrubEmails,
  scrubJwts,
} from "./audit-exec-log.js";

const AUDIT = join(import.meta.dirname, "..", "fixtures", "exec", "audit");
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function copyOfClean(): string {
  const dir = mkdtempSync(join(tmpdir(), "spicode-audit-"));
  temps.push(dir);
  cpSync(join(AUDIT, "clean"), dir, { recursive: true });
  return dir;
}

function plant(dir: string, line: number, from: string, to: string): void {
  const path = join(dir, "exec.jsonl");
  const lines = readFileSync(path, "utf8").split("\n");
  lines[line] = (lines[line] ?? "").replace(from, to);
  writeFileSync(path, lines.join("\n"));
}

describe("audit-exec-log", () => {
  test("passes a clean log whose every repository was public", () => {
    const result = auditSweep(join(AUDIT, "clean"));
    expect(result.findings).toEqual([]);
    expect(result.references).toEqual({ github: 2, gitlab: 1 });
  });

  test("fails a log that leaks an email address and a private repository", () => {
    expect(auditSweep(join(AUDIT, "leaky")).findings).toEqual([
      "exec.jsonl:4 stdout: email address (1)",
      "github acme/secret-plans: private",
    ]);
  });

  test("fails a copy of a clean log with a token planted in it", () => {
    const dir = copyOfClean();
    plant(dir, 0, "Token: <redacted>", `Token: ${"ghp_"}${"x".repeat(36)}`);
    expect(auditSweep(dir).findings).toEqual(["exec.jsonl:1 stdout: GitHub token"]);
  });

  test("fails an unredacted authorization header and a repository never checked", () => {
    const dir = copyOfClean();
    plant(
      dir,
      1,
      '"args":["api",',
      `"args":["api","-H","Authorization: bearer ${"a".repeat(24)}",`,
    );
    plant(dir, 2, "acme", "elsewhere");
    expect(auditSweep(dir).findings).toEqual([
      "exec.jsonl:2 args[2]: authorization header",
      "exec.jsonl:2 args[2]: bearer credential",
      "github elsewhere/gadgets: not checked at record time",
    ]);
  });

  test("scrubs emails without breaking the JSON around them", () => {
    const text = JSON.stringify({
      stdout: JSON.stringify({ author_email: "jane@example.com", note: "\njoe@example.org" }),
    });
    const scrubbed = scrubEmails(text);
    expect(JSON.parse(JSON.parse(scrubbed).stdout)).toEqual({
      author_email: "<email>",
      note: "\n<email>",
    });
  });

  test("allows a fenced call to name a private repository it never read", () => {
    const dir = copyOfClean();
    const call = {
      cmd: "gh",
      args: ["api", "repos/acme/vault/releases"],
      stdin: null,
      exit: 1,
      ms: 0,
    };
    const add = (entry: object) =>
      writeFileSync(
        join(dir, "exec.jsonl"),
        `${readFileSync(join(dir, "exec.jsonl"), "utf8").trimEnd()}\n${JSON.stringify(entry)}\n`,
      );
    const visibility = JSON.parse(readFileSync(join(dir, "visibility.json"), "utf8"));
    visibility.github["acme/vault"] = "private";
    writeFileSync(join(dir, "visibility.json"), JSON.stringify(visibility));
    add({ ...call, stdout: "", stderr: `${FENCE_MARK} acme/vault is private` });
    expect(auditSweep(dir).findings).toEqual([]);
    add({ ...call, stdout: "[]", stderr: `${FENCE_MARK} acme/vault is private` });
    expect(auditSweep(dir).findings).toEqual(["github acme/vault: private"]);
  });

  test("scrubs JSON web tokens", () => {
    const jwt = `eyJ${"a".repeat(10)}.eyJ${"b".repeat(10)}.${"c".repeat(10)}`;
    expect(scrubJwts(`token: ${jwt}\n`)).toBe(`token: ${JWT_MARK}\n`);
  });

  test("reads the repository names a recorded call carries", () => {
    const refs = references(
      'repos/a/b/pulls repository(owner: "c", name: "d") projects/x%2Fy%2Fz fullPath: "p/q"',
    );
    expect([...refs.github].sort()).toEqual(["a/b", "c/d"]);
    expect([...refs.gitlab].sort()).toEqual(["p/q", "x/y/z"]);
  });
});
