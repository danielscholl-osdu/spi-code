// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PROTOCOL_VERSION } from "../../packages/contracts/dist/index.js";
import { CopilotRuntime } from "../../packages/host/dist/copilot/runtime.js";
import { attachHostPort } from "../../packages/host/dist/process/port.js";
import { PrivilegedGit } from "../../packages/host/dist/scopes/git.js";
import { ScopeRegistry } from "../../packages/host/dist/scopes/registry.js";
import { ScopeWorkspaces } from "../../packages/host/dist/scopes/workspace.js";
import { ThreadRoutes } from "../../packages/host/dist/threads/routes.js";

const directory = await mkdtemp(join(await realpath(tmpdir()), "spi-thread-live-"));
const storePath = join(directory, "runs.sqlite");
const db = new DatabaseSync(storePath);
const capturedPath = process.env.PATH ?? "/usr/bin:/bin";
const git = new PrivilegedGit({ appData: directory, capturedPath });
const trace = process.argv.includes("--trace");
let stage = "read credential";
let host;
let timer;

try {
  const stored = execFileSync(
    "/usr/bin/security",
    ["find-generic-password", "-s", "gh:github.com", "-w"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 },
  ).trim();
  const wrapper = "go-keyring-base64:";
  const token = stored.startsWith(wrapper)
    ? Buffer.from(stored.slice(wrapper.length), "base64").toString("utf8")
    : stored;
  if (!token) throw new Error("Credential unavailable");

  stage = "create route";
  host = new ThreadRoutes({
    db,
    storePath,
    scopes: new ScopeRegistry(),
    savedSweep: () => undefined,
    env: process.env,
    git: async () => git,
    workspaces: (runner) => new ScopeWorkspaces(runner),
    runtime: async (onCredential) => {
      const runtime = new CopilotRuntime(
        { appDataDir: directory, capturedPath, onCredential },
        async () => token,
      );
      if (trace) {
        const open = runtime.openThreadSession.bind(runtime);
        runtime.openThreadSession = async (...args) => {
          const session = await open(...args);
          session.on(({ type, data }) => {
            console.log(
              "SDK",
              type,
              "turn id:",
              "turnId" in data,
              "message id:",
              "messageId" in data,
            );
          });
          return session;
        };
      }
      return runtime;
    },
  });
  let receive;
  const replies = new Map();
  const events = [];
  attachHostPort(
    {
      on: (_event, listener) => {
        receive = listener;
      },
      start: () => {},
      postMessage: ({ id, type, payload }) => {
        if (type === "thread.events") events.push(...payload.events);
        replies.get(id)?.({ type, payload });
      },
    },
    process.pid,
    host.routes,
  );
  function request(id, type, payload) {
    return new Promise((resolve) => {
      replies.set(id, resolve);
      receive({ data: { version: PROTOCOL_VERSION, id, kind: "request", type, payload } });
    }).finally(() => replies.delete(id));
  }
  const started = await request("start", "thread.start", { scope: "partition" });
  if (started.type !== "thread.started") throw new Error("Could not start the thread");
  const { threadId } = started.payload;
  receive({
    data: {
      version: PROTOCOL_VERSION,
      id: "subscribe",
      kind: "request",
      type: "thread.subscribe",
      payload: { threadId, fromSequence: 0 },
    },
  });
  stage = "send turn";
  const terminal = await Promise.race([
    request("send", "thread.send", {
      threadId,
      message: {
        prompt:
          "If a file read tool is available, read README.md first. Then reply with the exact text SPI-THREAD-OK and nothing else.",
      },
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Live turn timed out")), 90_000);
    }),
  ]);
  const answer = events
    .filter(({ type }) => type === "assistant.delta")
    .map(({ text }) => text)
    .join("");
  const reading = events.find(
    ({ type, name }) => type === "tool.started" && name === "workspace.reading",
  );
  const readingResult = events.find(
    ({ type, callId }) => type === "tool.finished" && callId === reading?.callId,
  )?.result;
  const tools = events.filter(
    ({ type, name }) => type === "tool.started" && name !== "workspace.reading",
  );
  const success =
    terminal.type === "thread.sent" &&
    terminal.payload.outcome === "completed" &&
    answer.trim() === "SPI-THREAD-OK" &&
    /^[a-f0-9]{40}$/u.test(readingResult?.head ?? "");
  console.log(
    JSON.stringify({
      scope: "partition",
      outcome: terminal.payload.outcome ?? "unknown",
      commitRecorded: /^[a-f0-9]{40}$/u.test(readingResult?.head ?? ""),
      fetch: readingResult?.fetch.state ?? "unknown",
      toolCount: tools.length,
      expectedReply: answer.trim() === "SPI-THREAD-OK",
    }),
  );
  if (!success) throw new Error("Probe did not meet its assertions");
} catch {
  console.error("Live thread probe failed at", stage);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  try {
    await host?.stop();
  } catch {
    console.error("Live thread probe could not shut down cleanly");
    process.exitCode = 1;
  }
  db.close();
  await rm(directory, { recursive: true, force: true });
}
