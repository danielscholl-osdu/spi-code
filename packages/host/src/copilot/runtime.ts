// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { accessSync, constants } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import {
  CopilotClient,
  type CopilotClientOptions,
  type CopilotSession,
  type PermissionHandler,
  type SessionConfig,
  type Tool,
} from "@github/copilot-sdk";
import type { ToolInstaller } from "@spi-code/tools";
import { ghAuthToken } from "../env/shell-environment.js";
import {
  buildManagedToolEnvironment,
  createManagedToolEnvironment,
} from "../env/tool-environment.js";

import { canonicalSandboxWorkspace, type SandboxWorkspace } from "./sandbox.js";
import {
  openSandboxedThread,
  type ThreadCopilotSession,
  type ThreadSessionOptions,
} from "./thread-session.js";

export type { SandboxWorkspace } from "./sandbox.js";
export type { ThreadCopilotSession, ThreadSessionOptions } from "./thread-session.js";

export const tokenLifetimeSeconds = 60;
const threadClientIdleMs = 30_000;
export type TokenSource = () => Promise<string>;
export type ModelCatalog = Awaited<ReturnType<CopilotClient["rpc"]["models"]["list"]>>;
type AccountQuota = Awaited<ReturnType<CopilotClient["rpc"]["account"]["getQuota"]>>;
export type RuntimeModelCatalog = {
  catalog: ModelCatalog;
  login: string | undefined;
  premium: AccountQuota["quotaSnapshots"][string];
};
const sessionTokens = new WeakMap<
  CopilotSession,
  { initial: ReadonlySet<string>; current: ReadonlySet<string> }
>();

function validateToken(token: string): string {
  if (!token || /[\s\p{Cc}]/u.test(token)) {
    throw new Error(
      "Invalid GitHub credential: expected a non-empty token without whitespace or control characters.",
    );
  }
  return token;
}

function redactError(error: unknown, tokens: ReadonlySet<string>): unknown {
  const seen = new WeakMap<object, unknown>();
  const redact = (value: unknown): unknown => {
    if (typeof value === "string") {
      let text = value;
      for (const token of tokens) {
        if (token) text = text.replaceAll(token, "[redacted]");
      }
      return text;
    }
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return seen.get(value);
    if (value instanceof Error) {
      const copy = value instanceof AggregateError ? new AggregateError([], "") : new Error();
      seen.set(value, copy);
      copy.message = String(redact(value.message));
      copy.name = String(redact(value.name));
      if (value.stack !== undefined) copy.stack = String(redact(value.stack));
      if ("cause" in value) copy.cause = redact(value.cause);
      if (value instanceof AggregateError && copy instanceof AggregateError) {
        copy.errors = value.errors.map(redact);
      }
      return copy;
    }
    const copy: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : {};
    seen.set(value, copy);
    for (const [key, entry] of Object.entries(value)) {
      Object.defineProperty(copy, String(redact(key)), {
        value: redact(entry),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return copy;
  };
  return redact(error);
}

export interface SessionToolSource {
  readonly availableTools: string[];
  readonly tools?: Tool[];
  readonly onPermissionRequest: PermissionHandler;
}

export const stubToolSource: SessionToolSource = {
  availableTools: [],
  onPermissionRequest: () => ({ kind: "denied-interactively-by-user" }),
};

export interface RuntimeOptions {
  readonly appDataDir: string;
  readonly capturedPath: string;
  readonly installer?: Pick<ToolInstaller, "binDir">;
  readonly env?: NodeJS.ProcessEnv;
  readonly cliPath?: string;
  readonly credentialMode?: "client" | "session";
  readonly onCredential?: (token: string) => void;
}

export function resolveRuntimePath(): string {
  const platform = `${process.platform}-${process.arch}`;
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve(`@github/copilot-sdk-${platform}/package.json`));
  const path = unpackRuntimePath(
    join(
      root,
      "prebuilds",
      platform,
      process.platform === "win32" ? "copilot-runtime.exe" : "copilot-runtime",
    ),
  );
  accessSync(path, constants.X_OK);
  return path;
}

export function unpackRuntimePath(path: string): string {
  return path.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
}

export async function buildAuthEnvironment(options: RuntimeOptions): Promise<NodeJS.ProcessEnv> {
  return createManagedToolEnvironment({
    appData: options.appDataDir,
    capturedPath: options.capturedPath,
    installer: options.installer ?? { binDir: async () => undefined },
    ...(options.env ? { env: options.env } : {}),
  });
}

export function buildClientOptions(
  options: RuntimeOptions,
  authEnvironment?: NodeJS.ProcessEnv | string,
  runtimeTemp?: string,
): CopilotClientOptions {
  const cliPath = options.cliPath ?? resolveRuntimePath();
  if (!isAbsolute(cliPath) || !isAbsolute(options.appDataDir)) {
    throw new Error("Copilot runtime and app data paths must be absolute.");
  }
  const home = join(options.appDataDir, "copilot", "home");
  const homes: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    APPDATA: join(home, "AppData", "Roaming"),
    // The SDK overwrites COPILOT_HOME with baseDirectory when spawning the runtime.
    COPILOT_HOME: join(options.appDataDir, "copilot"),
  };
  const source =
    typeof authEnvironment === "object"
      ? authEnvironment
      : buildManagedToolEnvironment({
          appData: options.appDataDir,
          capturedPath: options.capturedPath,
          toolsDir: authEnvironment ?? "",
          ...(options.env ? { env: options.env } : {}),
        });
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "LC_MESSAGES",
    "LC_COLLATE",
    "LC_NUMERIC",
    "LC_TIME",
    "LC_MONETARY",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
  ]) {
    const key = Object.keys(source).find((key) => key.toUpperCase() === name.toUpperCase());
    if (key !== undefined) env[name] = source[key];
  }
  if (runtimeTemp) {
    env.TMPDIR = runtimeTemp;
    env.TMP = runtimeTemp;
    env.TEMP = runtimeTemp;
  }
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GH_PROMPT_DISABLED: "1",
  });
  return {
    connection: { kind: "stdio", path: cliPath },
    mode: "empty",
    baseDirectory: join(options.appDataDir, "copilot"),
    workingDirectory: options.appDataDir,
    useLoggedInUser: false,
    logLevel: "none",
    env: { ...env, ...homes },
  };
}

export function buildSessionOptions(
  readToken: TokenSource,
  source: SessionToolSource,
  model = "auto",
): SessionConfig {
  return {
    model,
    streaming: true,
    availableTools: [...source.availableTools],
    ...(source.tools ? { tools: source.tools } : {}),
    onPermissionRequest: source.onPermissionRequest,
    gitHubTokenProvider: async () => ({
      kind: "token",
      accessToken: validateToken(await readToken()),
      expiresIn: tokenLifetimeSeconds,
    }),
  };
}

export function listModelsWithToken<T>(
  client: { rpc: { models: { list: (options: { gitHubToken: string }) => Promise<T> } } },
  gitHubToken: string,
): Promise<T> {
  validateToken(gitHubToken);
  return client.rpc.models.list({ gitHubToken });
}

type CredentialMode = "client" | "session" | "thread";

function connected(client: CopilotClient): boolean {
  try {
    return client.rpc !== undefined;
  } catch {
    return false;
  }
}

export class CopilotRuntime {
  private client: CopilotClient | undefined;
  private token: string | undefined;
  private mode: CredentialMode | undefined;
  private readonly readToken: (env?: NodeJS.ProcessEnv) => Promise<string>;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly tokens = new Set<string>();
  private readonly threadSessions = new Map<string, ThreadCopilotSession>();
  private threadIdleTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;

  get clientGeneration(): number {
    return this.generation;
  }

  constructor(
    private readonly options: RuntimeOptions,
    readToken?: TokenSource,
    private readonly source: SessionToolSource = stubToolSource,
    ghRunner: typeof ghAuthToken = ghAuthToken,
  ) {
    this.readToken = async (env) => {
      const token = readToken
        ? await readToken()
        : await ghRunner(env ?? (await buildAuthEnvironment(options)), {
            hostname: "github.com",
            timeoutMs: 5000,
          });
      this.tokens.clear();
      if (this.token) this.tokens.add(this.token);
      this.tokens.add(token);
      const checked = validateToken(token);
      this.options.onCredential?.(checked);
      return checked;
    };
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation).catch((error: unknown) => {
      throw redactError(error, this.tokens);
    });
    this.pending = result;
    return result;
  }

  private get threadRuntimeTemp(): string {
    return join(this.options.appDataDir, "copilot", "runtime-temp");
  }

  private async acquire(
    mode: CredentialMode = this.mode ?? this.options.credentialMode ?? "client",
  ): Promise<{ client: CopilotClient; token: string }> {
    const env = await buildAuthEnvironment(this.options);
    const token = await this.readToken(env);
    validateToken(token);
    if (this.client && this.mode === mode && token === this.token && connected(this.client)) {
      return { client: this.client, token };
    }
    await this.disposeClient();
    const runtimeTemp = mode === "thread" ? this.threadRuntimeTemp : undefined;
    if (runtimeTemp) await mkdir(runtimeTemp, { recursive: true, mode: 0o700 });
    const client = new CopilotClient({
      ...buildClientOptions(this.options, env, runtimeTemp),
      ...(mode === "client" ? { gitHubToken: token } : {}),
    });
    try {
      await client.start();
    } catch (error) {
      const errors = await client.stop();
      if (errors.length) throw new AggregateError([error, ...errors], "Copilot startup failed.");
      throw error;
    }
    this.client = client;
    this.mode = mode;
    this.token = token;
    this.generation++;
    return { client, token };
  }

  start(): Promise<void> {
    return this.serialize(async () => {
      await this.acquire();
    });
  }

  listModels(): Promise<ModelCatalog> {
    return this.serialize(async () => {
      const { client, token } = await this.acquire();
      return listModelsWithToken(client, token);
    });
  }

  listModelCatalog(): Promise<RuntimeModelCatalog> {
    return this.serialize(async () => {
      const { client, token } = await this.acquire();
      const [catalog, account, quota] = await Promise.all([
        listModelsWithToken(client, token),
        client.getAuthStatus().catch(() => undefined),
        client.rpc.account.getQuota({ gitHubToken: token }).catch(() => undefined),
      ]);
      return {
        catalog,
        login: account?.login,
        premium: quota?.quotaSnapshots.premium_interactions,
      };
    });
  }

  createSession(model = "auto"): Promise<CopilotSession> {
    return this.serialize(async () => {
      const { client } = await this.acquire(this.options.credentialMode ?? "client");
      const { gitHubTokenProvider, ...config } = buildSessionOptions(
        this.readToken,
        this.source,
        model,
      );
      const session = await client.createSession({
        ...config,
        ...(this.options.credentialMode === "session" ? { gitHubTokenProvider } : {}),
      });
      sessionTokens.set(session, { initial: new Set(this.tokens), current: this.tokens });
      return session;
    });
  }

  openThreadSession(
    workspace: SandboxWorkspace,
    options: ThreadSessionOptions,
  ): Promise<ThreadCopilotSession> {
    return this.serialize(async () => {
      const canonical = await canonicalSandboxWorkspace(workspace);
      const canaryRoot = join(this.options.appDataDir, "copilot", "sandbox-checks");
      await mkdir(canaryRoot, { recursive: true, mode: 0o700 });
      const { client, token } = await this.acquire("thread");
      clearTimeout(this.threadIdleTimer);
      if (options.resumeId !== undefined) {
        const previous = this.threadSessions.get(options.resumeId);
        this.threadSessions.delete(options.resumeId);
        await previous?.release();
      }
      let released = false;
      const thread = await openSandboxedThread(
        client,
        token,
        canonical,
        { canaryRoot, tempPath: this.threadRuntimeTemp },
        options,
        () => !released && this.client === client && connected(client),
        (operation) =>
          this.serialize(async () => {
            await this.acquire("thread");
            return operation();
          }).catch((error: unknown) => {
            throw redactError(error, new Set([token]));
          }),
      );
      this.threadSessions.set(thread.sessionId, thread);
      return {
        sessionId: thread.sessionId,
        get connected() {
          return thread.connected;
        },
        get sandbox() {
          return thread.sandbox;
        },
        on: thread.on,
        getEvents: thread.getEvents,
        abort: thread.abort,
        setModel: thread.setModel,
        send: thread.send,
        release: () => {
          released = true;
          return this.serialize(async () => {
            if (this.threadSessions.get(thread.sessionId) === thread) {
              this.threadSessions.delete(thread.sessionId);
            }
            try {
              await thread.release();
            } finally {
              if (this.client === client && this.threadSessions.size === 0) {
                clearTimeout(this.threadIdleTimer);
                this.threadIdleTimer = setTimeout(() => {
                  void this.serialize(async () => {
                    if (this.client === client && this.threadSessions.size === 0)
                      await this.disposeClient();
                  }).catch(() => {});
                }, threadClientIdleMs);
                this.threadIdleTimer.unref();
              }
            }
          });
        },
      };
    });
  }

  private async disposeClient(force = false): Promise<void> {
    clearTimeout(this.threadIdleTimer);
    const client = this.client;
    this.client = undefined;
    this.mode = undefined;
    this.token = undefined;
    const threads = [...this.threadSessions.values()];
    this.threadSessions.clear();
    if (!client) return;
    try {
      if (force) {
        await client.forceStop();
        return;
      }
      const errors = await client.stop();
      if (errors.length) throw new AggregateError(errors, "Copilot runtime shutdown failed.");
    } finally {
      await Promise.allSettled(threads.map((thread) => thread.release()));
    }
  }

  stop(): Promise<void> {
    return this.serialize(() => this.disposeClient());
  }

  restartThreadClient(generation: number): Promise<void> {
    return this.serialize(async () => {
      if (this.generation === generation && this.mode === "thread") await this.disposeClient(true);
    });
  }
}

export async function streamTurn(
  session: CopilotSession,
  prompt: string,
  onDelta: (text: string) => void,
  timeoutMs = 60_000,
): Promise<void> {
  try {
    const unsubscribe = session.on("assistant.message_delta", (event) => {
      if (event.data.deltaContent) onDelta(event.data.deltaContent);
    });
    try {
      await session.sendAndWait({ prompt }, timeoutMs);
    } finally {
      unsubscribe();
    }
  } catch (error) {
    const tokens = sessionTokens.get(session);
    throw redactError(error, new Set([...(tokens?.initial ?? []), ...(tokens?.current ?? [])]));
  }
}
