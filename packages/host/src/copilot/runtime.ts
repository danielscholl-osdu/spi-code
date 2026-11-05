// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { accessSync, constants } from "node:fs";
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
import { buildToolEnvironment, ghAuthToken } from "../env/shell-environment.js";

export const tokenLifetimeSeconds = 60;
export type TokenSource = () => Promise<string>;
export type ModelCatalog = Awaited<ReturnType<CopilotClient["rpc"]["models"]["list"]>>;
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

function authEnvironment(options: RuntimeOptions, toolsDir = ""): NodeJS.ProcessEnv {
  return buildToolEnvironment({
    toolsDir,
    capturedPath: options.capturedPath,
    kubeconfig: join(options.appDataDir, "kubeconfig"),
    azureConfigDir: join(options.appDataDir, "azure"),
    ...(options.env ? { env: options.env } : {}),
  });
}

export async function buildAuthEnvironment(options: RuntimeOptions): Promise<NodeJS.ProcessEnv> {
  return authEnvironment(options, await options.installer?.binDir("gh"));
}

export function buildClientOptions(
  options: RuntimeOptions,
  authPath?: string,
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
  const env = authEnvironment(options, authPath);
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase();
    if (Object.hasOwn(homes, upper) || upper === "HOMEDRIVE" || upper === "HOMEPATH") {
      delete env[name];
    }
  }
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

export class CopilotRuntime {
  private client: CopilotClient | undefined;
  private token: string | undefined;
  private readonly readToken: TokenSource;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly tokens = new Set<string>();
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
    const reader =
      readToken ??
      (async () =>
        ghRunner(await buildAuthEnvironment(options), {
          hostname: "github.com",
          timeoutMs: 5000,
        }));
    this.readToken = async () => {
      const token = await reader();
      this.tokens.clear();
      if (this.token) this.tokens.add(this.token);
      this.tokens.add(token);
      return validateToken(token);
    };
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation).catch((error: unknown) => {
      throw redactError(error, this.tokens);
    });
    this.pending = result;
    return result;
  }

  private async acquire(token: string): Promise<CopilotClient> {
    validateToken(token);
    if (this.client && (this.options.credentialMode === "session" || token === this.token)) {
      return this.client;
    }
    await this.disposeClient();
    const client = new CopilotClient({
      ...buildClientOptions(this.options, (await buildAuthEnvironment(this.options)).PATH),
      ...(this.options.credentialMode === "session" ? {} : { gitHubToken: token }),
    });
    try {
      await client.start();
    } catch (error) {
      const errors = await client.stop();
      if (errors.length) throw new AggregateError([error, ...errors], "Copilot startup failed.");
      throw error;
    }
    this.client = client;
    this.token = token;
    this.generation++;
    return client;
  }

  start(): Promise<void> {
    return this.serialize(async () => {
      await this.acquire(await this.readToken());
    });
  }

  listModels(): Promise<ModelCatalog> {
    return this.serialize(async () => {
      const token = await this.readToken();
      return listModelsWithToken(await this.acquire(token), token);
    });
  }

  createSession(model = "auto"): Promise<CopilotSession> {
    return this.serialize(async () => {
      const client = await this.acquire(await this.readToken());
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

  private async disposeClient(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.token = undefined;
    if (!client) return;
    const errors = await client.stop();
    if (errors.length) throw new AggregateError(errors, "Copilot runtime shutdown failed.");
  }

  stop(): Promise<void> {
    return this.serialize(() => this.disposeClient());
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
