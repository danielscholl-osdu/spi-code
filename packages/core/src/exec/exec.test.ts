// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { RecordingExec, ReplayExec, type ExecOptions, type ExecOutput } from "./index.js";
import { execOutputDelivery, execRedactor } from "./port.js";

describe("exec recording and replay", () => {
  it.each([
    ["Authorization\n", ": opaque-value"],
    ["Bearer\n", "opaque-value"],
  ])("holds the split introducer %j before any credential can stream", (header, value) => {
    const chunks: string[] = [];
    const delivery = execOutputDelivery({ onOutput: (_stream, text) => chunks.push(text) });
    delivery.push("stderr", header);
    expect(chunks).toEqual([]);
    delivery.push("stderr", value);
    expect(chunks).toEqual([]);
    delivery.push("stderr", "\nDone!\n");
    delivery.finish();
    expect(chunks.join("")).toBe(execRedactor({})(`${header}${value}\nDone!\n`));
    expect(chunks.join("")).not.toContain("opaque-value");
  });

  it.each(["Bearer\n", "Authorization:\r\n", "Authorization:\n\n", "bEaReR \r\n ",
    "Authorization\n:", "Authorization \r\n = ",
  ])(
    "holds a multiline credential introducer %j until its value is redacted",
    (header) => {
      const chunks: string[] = [];
      const delivery = execOutputDelivery({ onOutput: (_stream, text) => chunks.push(text) });
      delivery.push("stderr", header);
      expect(chunks).toEqual([]);
      delivery.push("stderr", "opaque-value");
      delivery.push("stderr", "\nDone!\n");
      delivery.finish();
      expect(chunks.join("")).toBe(execRedactor({})(`${header}opaque-value\nDone!\n`));
      expect(chunks.join("")).not.toContain("opaque-value");
    },
  );

  it.each([
    ["opaque.g", "opaque.gh", { stdin: "opaque.g\n" }],
    ["opaque.gh", "opaque.ghp_", { stdin: "opaque.gh" }],
    ["opaque.b", "opaque.bear", { env: { SERVICE_TOKEN: "opaque.b" } }],
    ["opaque.credential", "opaque.credentialX", {
      stdin: "opaque.credential", env: { SERVICE_TOKEN: "credentialXYZ" },
    }],
  ] satisfies [string, string, ExecOptions][])(
    "keeps overlapping secret %s intact during redaction",
    (secret, first, opts) => {
      const chunks: string[] = [];
      const delivery = execOutputDelivery({
        ...opts, onOutput: (_stream, text) => chunks.push(text),
      });
      delivery.push("stdout", first);
      expect(chunks).toEqual([]);
      delivery.push("stdout", "!\n");
      delivery.finish();
      expect(chunks.join("")).toBe(execRedactor(opts)(`${first}!\n`));
      expect(chunks.join("")).not.toContain(secret);
      expect(chunks.join("")).not.toContain("opaque.");
    },
  );

  it.each([
    ["opaque.gh", { stdin: "opaque.gh\n" }],
    ["environment.credential", { env: { SERVICE_TOKEN: "environment.credential" } }],
    ["ghp_planted", {}],
  ] satisfies [string, ExecOptions][])("protects %s split across three or more chunks", (secret, opts) => {
    for (let first = 1; first < secret.length - 1; first++) {
      for (let second = first + 1; second < secret.length; second++) {
        const chunks: string[] = [];
        const delivery = execOutputDelivery({
          ...opts, onOutput: (_stream, text) => chunks.push(text),
        });
        for (const chunk of [
          secret.slice(0, first), secret.slice(first, second), secret.slice(second), "!\n",
        ]) delivery.push("stderr", chunk);
        delivery.finish();
        expect(chunks.join("")).toBe("<redacted>!\n");
      }
    }
  });

  it.each([
    ["y\n", "my repository error", "my repository error"],
    ["1234567\n", "input 1234567 failed", "input 1234567 failed"],
    ["12345678\n", "input 12345678 failed", "input <redacted> failed"],
  ])("redacts stdin only at the minimum secret length: %j", (stdin, text, expected) => {
    const opts = { stdin };
    expect(execRedactor(opts)(text)).toBe(expected);
    const chunks: string[] = [];
    const delivery = execOutputDelivery({
      ...opts, onOutput: (_stream, chunk) => chunks.push(chunk),
    });
    for (const character of text) delivery.push("stdout", character);
    delivery.finish();
    expect(chunks.join("")).toBe(expected);
  });

  it.each([
    ["ghp_planted", {}],
    ["github_pat_planted", {}],
    ["glpat-planted", {}],
    ["Authorization: Basic credential", {}],
    ["Bearer credential", {}],
    ["Authorization:\r\nBasic credential", {}],
    ["Authorization:\n\ncredential", {}],
    ["Bearer\ncredential", {}],
    ["Authorization\n: credential", {}],
    ["Bearer\n opaque-value", {}],
    ["opaque.credential", { stdin: "opaque.credential\n" }],
    ["environment.credential", { env: { SERVICE_TOKEN: "environment.credential" } }],
  ] satisfies [string, ExecOptions][])("redacts %s across every chunk boundary", (secret, opts) => {
    for (let split = 1; split < secret.length; split++) {
      const chunks: string[] = [];
      const delivery = execOutputDelivery({
        ...opts, onOutput: (_stream, text) => chunks.push(text),
      });
      delivery.push("stdout", secret.slice(0, split));
      delivery.push("stdout", secret.slice(split));
      delivery.push("stdout", "\n");
      delivery.finish();
      const text = chunks.join("");
      expect(text).toBe(execRedactor(opts)(`${secret}\n`));
      expect(text).not.toContain(secret);
      expect(text).not.toContain("credential");
      expect(text).toContain("<redacted>");
    }
  });

  it("delivers plain chunks without a newline and redacts buffered-runner output on replay", async () => {
    const chunks: string[] = [];
    execOutputDelivery({ onOutput: (_stream, text) => chunks.push(text) }).push("stdout", "ready");
    expect(chunks).toEqual(["ready"]);
    let log = "";
    const recording = new RecordingExec(async () => ({
      stdout: "ghp_planted", stderr: "warning", exit: 0,
    }), (line) => { log += line; });
    const streamed = { stdout: "", stderr: "" };
    const opts: ExecOptions = { onOutput: (stream, text) => { streamed[stream] += text; } };
    await recording.runText("gh", [], opts);
    expect(streamed).toEqual({ stdout: "<redacted>", stderr: "warning" });
    streamed.stdout = "";
    streamed.stderr = "";
    await new ReplayExec(log).runText("gh", [], opts);
    expect(streamed).toEqual({ stdout: "<redacted>", stderr: "warning" });
  });

  it("forwards the signal to the recording runner and stops replay progress on abort", async () => {
    const controller = new AbortController();
    let log = "";
    const recording = new RecordingExec(async (_cmd, _args, opts) => {
      expect(opts.signal).toBe(controller.signal);
      controller.abort();
      return { stdout: "ready", stderr: "waiting", exit: 0 };
    }, (line) => { log += line; });
    expect(await recording.runText("gh", [], { signal: controller.signal })).toMatchObject({
      ok: false, error: "Command aborted.",
    });
    const replayController = new AbortController();
    const chunks: string[] = [];
    expect(await new ReplayExec(log).runText("gh", [], {
      signal: replayController.signal,
      onOutput: (_stream, text) => { chunks.push(text); replayController.abort(); },
    })).toMatchObject({ ok: false, error: "Command aborted." });
    expect(chunks).toEqual(["ready"]);
  });

  it("delivers live and replay output redacted, without recording transient stdin", async () => {
    let log = "";
    const chunks: [string, string][] = [];
    const secret = "opaque.credential";
    const recording = new RecordingExec(async (_cmd, _args, opts) => {
      opts.onOutput?.("stderr", "gh");
      opts.onOutput?.("stderr", `p_planted ${secret}\n`);
      opts.onOutput?.("stdout", "ready\n");
      expect(chunks).toEqual([["stderr", "<redacted> <redacted>\n"], ["stdout", "ready\n"]]);
      return { stdout: "ready\n", stderr: `ghp_planted ${secret}\n`, exit: 0 };
    }, (line) => { log += line; });
    const opts: ExecOptions = {
      stdin: `${secret}\n`,
      onOutput: (stream, text) => chunks.push([stream, text]),
    };
    expect(await recording.runText("glab", [], opts)).toMatchObject({ ok: true });
    expect(log).not.toContain(secret);
    expect(log).not.toContain("ghp_planted");
    const live = [...chunks];
    chunks.length = 0;
    await new ReplayExec(log).runText("glab", [], opts);
    expect(chunks).toEqual([live[1], live[0]]);
  });

  it("redacts stdin echoed by a failing runner and rejects pre-aborted replay without consuming it", async () => {
    const secret = "opaque.credential";
    let log = "";
    const recording = new RecordingExec(async () => { throw new Error(secret); },
      (line) => { log += line; });
    expect(await recording.runText("glab", [], { stdin: secret })).toEqual({
      ok: false, error: "<redacted>", code: null,
    });
    const replay = new ReplayExec(log);
    expect(await replay.runText("glab", [], {
      stdin: secret, signal: AbortSignal.abort(secret),
    })).toEqual({ ok: false, error: "Command aborted.", code: null });
    await replay.runText("glab", [], { stdin: secret });
    replay.assertExhausted();
  });

  it("reproduces text, JSON, nonzero exits, parse failures and runner errors", async () => {
    let log = "";
    const outputs: ExecOutput[] = [
      { stdout: "hello\n", stderr: "warning", exit: 0 },
      { stdout: 'warning\n{"value":42}', stderr: "", exit: 0 },
      { stdout: "logical failure", stderr: "bad\nmore", exit: 2 },
      { stdout: '{"accepted":true}', stderr: "warning", exit: 3 },
      { stdout: "not JSON", stderr: "", exit: 0 },
      { stdout: "{invalid", stderr: "", exit: 0 },
    ];
    const recording = new RecordingExec(async () => {
      const output = outputs.shift();
      if (!output) throw new Error("runner unavailable");
      return output;
    }, (line) => { log += line; });
    const options = [{}, {}, {}, { acceptNonZeroExit: true }, {}, {}, {}];
    const expected = [];
    for (const [i, opts] of options.entries()) {
      expected.push(await (i === 0 || i === 2 || i === 6
        ? recording.runText("gh", [String(i)], opts)
        : recording.runJSON("gh", [String(i)], opts)));
    }
    expect(expected.slice(0, 4)).toEqual([
      { ok: true, data: "hello\n", exitCode: 0 },
      { ok: true, data: { value: 42 }, exitCode: 0 },
      { ok: false, error: "bad", code: 2 },
      { ok: true, data: { accepted: true }, exitCode: 3 },
    ]);
    expect(expected[4]).toEqual({ ok: false, error: "no JSON found in output", code: null });
    expect(expected[5]).toMatchObject({ ok: false, error: expect.stringContaining("invalid JSON:") });
    expect(expected[6]).toEqual({ ok: false, error: "runner unavailable", code: null });
    const replay = new ReplayExec(log);
    for (const [i, opts] of options.entries()) {
      const actual = await (i === 0 || i === 2 || i === 6
        ? replay.runText("gh", [String(i)], opts)
        : replay.runJSON("gh", [String(i)], opts));
      expect(actual).toEqual(expected[i]);
    }
    replay.assertExhausted();
    expect(JSON.parse(log.split("\n")[0] ?? "")).toMatchObject({
      cmd: "gh", args: ["0"], stdin: null, stdout: "hello\n", stderr: "warning", exit: 0,
      ms: expect.any(Number),
    });
  });

  it("names unexpected commands and arguments without consuming the entry", async () => {
    const replay = new ReplayExec('{"cmd":"gh","args":["api"],"stdin":null,"stdout":"","stderr":"","exit":0,"ms":1}\n');
    await expect(replay.runText("git", ["status"])).rejects.toThrow('git ["status"]');
    expect(() => replay.assertExhausted()).toThrow('gh ["api"]');
    await replay.runText("gh", ["api"]);
    replay.assertExhausted();
    await expect(replay.runText("glab", ["api"])).rejects.toThrow('glab ["api"]');
  });

  it.each([
    "gho_oauth123", "ghp_personal123", "ghs_install123", "github_pat_fine123", "glpat-gitlab123",
    "Authorization: Basic credential123", "Bearer bearer123", "custom-secret123",
    "ghu_user123", "ghr_refresh123",
  ])("strips %s from all written fields, including thrown error text", async (secret) => {
    let log = "";
    const env = { CUSTOM_TOKEN_VALUE: "custom-secret123" };
    const recording = new RecordingExec(async () => ({
      stdout: secret, stderr: secret, exit: 0,
    }), (line) => { log += line; }, env);
    await recording.runText(secret, [secret], { stdin: secret });
    const throwing = new RecordingExec(async () => { throw new Error(secret); }, (line) => {
      log += line;
    }, env);
    const result = await throwing.runText("gh", [secret]);
    expect(result.ok).toBe(false);
    expect(log).not.toContain(secret);
    expect(log).not.toContain("credential123");
    expect(log).not.toContain("bearer123");
    const replay = new ReplayExec(log, env);
    await replay.runText(secret, [secret], { stdin: secret });
    expect(await replay.runText("gh", [secret])).toMatchObject({ ok: false });
    replay.assertExhausted();
  });

  it("forwards options and redacts call-specific token environment values", async () => {
    let log = "";
    const options: ExecOptions = {
      cwd: "/work", timeoutMs: 1, env: { MY_TOKEN: "secret.with+regex" }, stdin: "input",
    };
    const recording = new RecordingExec(async (cmd, args, opts) => {
      expect([cmd, args, opts]).toEqual(["gh", ["secret.with+regex"], options]);
      return { stdout: "secret.with+regex", stderr: "", exit: 0 };
    }, (line) => { log += line; });
    await recording.runText("gh", ["secret.with+regex"], options);
    expect(log).not.toContain("secret.with+regex");
    const replay = new ReplayExec(log);
    await replay.runText("gh", ["secret.with+regex"], options);
    replay.assertExhausted();
  });

  it("writes concurrent calls in invocation order, not completion order", async () => {
    let log = "";
    let release: ((output: ExecOutput) => void) | undefined;
    const recording = new RecordingExec(async (_cmd, args) => {
      if (args[0] === "first") return new Promise<ExecOutput>((resolve) => { release = resolve; });
      return { stdout: "second", stderr: "", exit: 0 };
    }, (line) => { log += line; });
    const first = recording.runText("gh", ["first"]);
    const second = recording.runText("gh", ["second"]);
    release?.({ stdout: "first", stderr: "", exit: 0 });
    await Promise.all([first, second]);
    const replay = new ReplayExec(log);
    expect(await replay.runText("gh", ["first"])).toMatchObject({ data: "first" });
    expect(await replay.runText("gh", ["second"])).toMatchObject({ data: "second" });
    replay.assertExhausted();
  });

  it("rejects malformed logs and surfaces sink failures", async () => {
    expect(() => new ReplayExec("{}\n")).toThrow();
    expect(() => new ReplayExec("not json\n")).toThrow();
    const recording = new RecordingExec(async () => ({ stdout: "", stderr: "", exit: 0 }), () => {
      throw new Error("disk full");
    });
    await expect(recording.runText("gh", [])).rejects.toThrow("disk full");
  });

  it("records again after a sink failure", async () => {
    let log = "";
    let fail = true;
    const recording = new RecordingExec(async (_cmd, args) => ({
      stdout: args[0] ?? "", stderr: "", exit: 0,
    }), (line) => {
      if (fail) { fail = false; throw new Error("disk full"); }
      log += line;
    });
    await expect(recording.runText("gh", ["lost"])).rejects.toThrow("disk full");
    expect(await recording.runText("gh", ["kept"])).toMatchObject({ ok: true, data: "kept" });
    const replay = new ReplayExec(log);
    await replay.runText("gh", ["kept"]);
    replay.assertExhausted();
  });

  it("replays JSON unchanged when a redaction precedes the payload or a short token flag is set", async () => {
    let log = "";
    const env = { TOKENIZERS_PARALLELISM: "false" };
    const outputs: ExecOutput[] = [
      { stdout: 'warning: ghp_fakeSecret123\n{"value":42}', stderr: "", exit: 0 },
      { stdout: '{"draft":false}', stderr: "", exit: 0 },
    ];
    const recording = new RecordingExec(async () => outputs.shift() ?? {
      stdout: "", stderr: "", exit: 0,
    }, (line) => { log += line; }, env);
    const live = [await recording.runJSON("gh", ["a"]), await recording.runJSON("gh", ["b"])];
    expect(live).toEqual([
      { ok: true, data: { value: 42 }, exitCode: 0 },
      { ok: true, data: { draft: false }, exitCode: 0 },
    ]);
    expect(log).not.toContain("ghp_fakeSecret123");
    const replay = new ReplayExec(log, env);
    expect([await replay.runJSON("gh", ["a"]), await replay.runJSON("gh", ["b"])]).toEqual(live);
    replay.assertExhausted();
  });

  it.each([
    ["HTTP_AUTHORIZATION=httpauth123", "httpauth123"],
    ['{\\"Authorization\\": \\"token escaped123\\"}', "escaped123"],
  ])("strips the credential from %s", async (text, credential) => {
    let log = "";
    const recording = new RecordingExec(async () => ({ stdout: text, stderr: "", exit: 0 }),
      (line) => { log += line; });
    await recording.runText("env", []);
    expect(log).not.toContain(credential);
  });
});
