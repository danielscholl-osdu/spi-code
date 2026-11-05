// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CopilotClient, type CopilotClientOptions, type SessionConfig } from "@github/copilot-sdk";
import {
  buildClientOptions,
  buildSessionOptions,
  listModelsWithToken,
  type RuntimeOptions,
  stubToolSource,
  type TokenSource,
} from "../copilot/runtime.js";
import { ghAuthToken } from "../env/shell-environment.js";

export type SeatResult =
  | { kind: "seat-ok"; models: string[] }
  | { kind: "no-seat"; reason: string }
  | { kind: "sign-in"; reason: string; classicToken?: true }
  | { kind: "error"; reason: string };

interface ProbeSession {
  disconnect(): Promise<void>;
}

export interface SeatClient {
  start(): Promise<void>;
  createSession(config: SessionConfig): Promise<ProbeSession>;
  rpc: { models: { list(token: { gitHubToken: string }): Promise<{ models: { id: string }[] }> } };
  stop(): Promise<Error[]>;
  forceStop(): Promise<void>;
}

export interface SeatProbeOptions extends RuntimeOptions {
  readonly timeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly readToken?: TokenSource;
  readonly createClient?: (options: CopilotClientOptions) => SeatClient;
}

class ProbeTimeout extends Error {
  constructor() {
    super("Copilot seat probe timed out.");
  }
}

// Gemini observed models.list failures "Failed to fetch Copilot user info: 403 Forbidden"
// and "404 Not Found". Operator bead spicode-t1k.73 will confirm the live no-seat text.
const noSeatPattern =
  /\b40[34]\b|forbidden|not authorized|no access to Copilot|no (?:copilot )?(?:seat|subscription|entitlement)|no entitled models|not entitled|access denied/iu;
const signInPattern = /\b401\b|unauthorized|bad credentials|not authenticated/iu;

async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProbeTimeout()), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function errorText(error: unknown, token: string): string {
  const text =
    error instanceof AggregateError
      ? [error.message, ...error.errors.map((entry) => errorText(entry, token))].join("; ")
      : error !== null &&
          typeof error === "object" &&
          "message" in error &&
          typeof error.message === "string"
        ? error.message
        : typeof error === "string"
          ? error
          : "Unknown Copilot SDK error.";
  return (token ? text.replaceAll(token, "[redacted]") : text).replace(
    /\b(?:gh[oprsu]_|github_pat_)[A-Za-z0-9_]+/gu,
    "[redacted]",
  );
}

/** Uses the landed runtime's empty-mode boundary and CP-03 client-token fallback. */
export async function probeCopilotSeat(options: SeatProbeOptions): Promise<SeatResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const cleanupMs = options.cleanupTimeoutMs ?? 5_000;
  if (
    [timeoutMs, cleanupMs].some(
      (value) => !Number.isFinite(value) || value <= 0 || value > 2_147_483_647,
    )
  ) {
    return { kind: "error", reason: "Invalid Copilot seat probe timeout." };
  }
  let token = "";
  let client: SeatClient | undefined;
  let session: ProbeSession | undefined;
  let phase = "configuration";
  let timedOut = false;
  let result: SeatResult;
  try {
    const config = buildClientOptions(options);
    phase = "credential";
    token = await bounded(
      options.readToken?.() ?? ghAuthToken(config.env ?? {}, { timeoutMs }),
      timeoutMs,
    );
    if (!token || /[\s\p{Cc}]/u.test(token)) {
      return { kind: "sign-in", reason: "Sign in with gh OAuth: the credential is invalid." };
    }
    if (token.startsWith("ghp_")) {
      return {
        kind: "sign-in",
        classicToken: true,
        reason: "A classic ghp_ token cannot authenticate Copilot. Sign in with gh OAuth.",
      };
    }
    phase = "configuration";
    await bounded(mkdir(join(options.appDataDir, "copilot"), { recursive: true }), timeoutMs);
    client = (options.createClient ?? ((config) => new CopilotClient(config)))({
      ...config,
      gitHubToken: token,
    });
    phase = "startup";
    await bounded(client.start(), timeoutMs);
    phase = "session";
    const { gitHubTokenProvider: _, ...sessionConfig } = buildSessionOptions(
      async () => token,
      stubToolSource,
    );
    session = await bounded(client.createSession(sessionConfig), timeoutMs);
    phase = "models";
    const { models } = await bounded(listModelsWithToken(client, token), timeoutMs);
    result = models.length
      ? { kind: "seat-ok", models: models.map((model) => model.id) }
      : { kind: "no-seat", reason: "Copilot returned no entitled models." };
  } catch (error) {
    timedOut = error instanceof ProbeTimeout;
    const reason = errorText(error, token);
    const sessionOrModels = phase === "session" || phase === "models";
    const kind =
      !timedOut && (phase === "credential" || (sessionOrModels && signInPattern.test(reason)))
        ? "sign-in"
        : sessionOrModels && !timedOut && noSeatPattern.test(reason)
          ? "no-seat"
          : "error";
    result = { kind, reason };
  }
  const cleanupErrors: string[] = [];
  if (session) {
    try {
      await bounded(session.disconnect(), cleanupMs);
    } catch (error) {
      cleanupErrors.push(errorText(error, token));
    }
  }
  if (client) {
    let stopFailed = false;
    try {
      const errors = await bounded(client.stop(), cleanupMs);
      if (errors.length) throw new AggregateError(errors, "Copilot shutdown failed.");
    } catch (error) {
      stopFailed = true;
      cleanupErrors.push(errorText(error, token));
    }
    if (stopFailed || timedOut) {
      try {
        await bounded(client.forceStop(), cleanupMs);
      } catch (error) {
        cleanupErrors.push(errorText(error, token));
      }
    }
  }
  if (cleanupErrors.length) {
    return {
      kind: "error",
      reason: [
        ...(result.kind === "seat-ok" ? [] : [result.reason]),
        "Copilot cleanup failed",
        ...cleanupErrors,
      ].join("; "),
    };
  }
  return result;
}
