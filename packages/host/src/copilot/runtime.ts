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
import { buildToolEnvironment, ghAuthToken } from "../env/shell-environment.js";

export const tokenLifetimeSeconds = 60;
export type TokenSource = () => Promise<string>;
export type ModelCatalog = Awaited<ReturnType<CopilotClient["rpc"]["models"]["list"]>>;

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
  readonly env?: NodeJS.ProcessEnv;
  readonly cliPath?: string;
  readonly credentialMode?: "client" | "session";
}

export function resolveRuntimePath(): string {
  const platform = `${process.platform}-${process.arch}`;
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve(`@github/copilot-sdk-${platform}/package.json`));
  const path = join(
    root,
    "prebuilds",
    platform,
    process.platform === "win32" ? "copilot-runtime.exe" : "copilot-runtime",
  );
  accessSync(path, constants.X_OK);
  return path;
}

export function buildClientOptions(options: RuntimeOptions): CopilotClientOptions {
  const cliPath = options.cliPath ?? resolveRuntimePath();
  if (!isAbsolute(cliPath) || !isAbsolute(options.appDataDir)) {
    throw new Error("Copilot runtime and app data paths must be absolute.");
  }
  return {
    connection: { kind: "stdio", path: cliPath },
    mode: "empty",
    baseDirectory: join(options.appDataDir, "copilot"),
    workingDirectory: options.appDataDir,
    useLoggedInUser: false,
    logLevel: "none",
    env: buildToolEnvironment({
      toolsDir: join(options.appDataDir, "tools", "bin"),
      capturedPath: options.capturedPath,
      kubeconfig: join(options.appDataDir, "kubeconfig"),
      azureConfigDir: join(options.appDataDir, "azure"),
      ...(options.env ? { env: options.env } : {}),
    }),
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
      accessToken: await readToken(),
      expiresIn: tokenLifetimeSeconds,
    }),
  };
}

export function listModelsWithToken<T>(
  client: { rpc: { models: { list: (options: { gitHubToken: string }) => Promise<T> } } },
  gitHubToken: string,
): Promise<T> {
  if (!gitHubToken.trim()) throw new Error("gh returned an empty GitHub token.");
  return client.rpc.models.list({ gitHubToken });
}

export class CopilotRuntime {
  private client: CopilotClient | undefined;
  private token: string | undefined;
  private readonly config: CopilotClientOptions;
  private readonly readToken: TokenSource;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly options: RuntimeOptions,
    readToken?: TokenSource,
    private readonly source: SessionToolSource = stubToolSource,
  ) {
    this.config = buildClientOptions(options);
    this.readToken = readToken ?? (() => ghAuthToken(this.config.env ?? {}));
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result;
    return result;
  }

  private async acquire(token: string): Promise<CopilotClient> {
    if (!token.trim()) throw new Error("gh returned an empty GitHub token.");
    if (this.client && (this.options.credentialMode === "session" || token === this.token)) {
      return this.client;
    }
    await this.disposeClient();
    const client = new CopilotClient({
      ...this.config,
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
      return client.createSession({
        ...config,
        ...(this.options.credentialMode === "session" ? { gitHubTokenProvider } : {}),
      });
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
  const unsubscribe = session.on("assistant.message_delta", (event) => {
    if (event.data.deltaContent) onDelta(event.data.deltaContent);
  });
  try {
    await session.sendAndWait({ prompt }, timeoutMs);
  } finally {
    unsubscribe();
  }
}
