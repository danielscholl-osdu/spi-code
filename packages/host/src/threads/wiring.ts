// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { realpathSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";
import type { Tool } from "@github/copilot-sdk";
import { createToolOutputRedactor, ThreadEngine, type ToolOutputRedactor } from "@spi-code/threads";
import type { CopilotRuntime } from "../copilot/runtime.js";
import type { PrivilegedGit } from "../scopes/git.js";
import type { ScopeRegistry } from "../scopes/registry.js";
import type { ScopeWorkspaces } from "../scopes/workspace.js";
import { offeredTools, spiReadTools, spiToolProvider } from "../tools/spi-reads.js";
import { type AskingTurnWorkspace, CopilotThreadAdapter } from "./adapter.js";
import { chipFromSweep } from "./context/draft.js";
import { threadContext } from "./context/provider.js";
import { redactSpiText, type SpiRedactor } from "./context/redaction.js";
import type { LatestSweep } from "./context/sweep.js";

export interface ThreadHostOptions {
  db: DatabaseSync;
  storePath: string;
  scopes: ScopeRegistry;
  savedSweep: LatestSweep;
  git: () => Promise<PrivilegedGit>;
  workspaces: (git: PrivilegedGit) => ScopeWorkspaces;
  runtime: (onCredential: (token: string) => void) => Promise<CopilotRuntime>;
  env: NodeJS.ProcessEnv;
  onThreadsChanged?: () => void;
}

export function openThreadHost(options: ThreadHostOptions) {
  const { db, storePath, scopes } = options;
  const lock = new DatabaseSync(`${realpathSync(storePath)}.threads-lock`);
  try {
    // The rollback-mode lock is released by SQLite even if the host process dies.
    lock.exec("BEGIN EXCLUSIVE");
    db.exec(
      "CREATE TABLE IF NOT EXISTS thread_session_ids (id TEXT PRIMARY KEY, session_id TEXT NOT NULL) STRICT",
    );
    const read = db.prepare("SELECT session_id FROM thread_session_ids WHERE id = ?");
    const write = db.prepare(
      "INSERT INTO thread_session_ids VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id",
    );
    const secrets = new Set(
      Object.entries(options.env)
        .filter(([name]) =>
          /^(?:COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN|GITLAB_TOKEN|GLAB_TOKEN|GITLAB_ACCESS_TOKEN)$/iu.test(
            name,
          ),
        )
        .map(([, value]) => value)
        .filter((value): value is string => Boolean(value)),
    );
    let profiles = createToolOutputRedactor(secrets);
    const modelRedactor: ToolOutputRedactor = {
      text: (value) => profiles.model.text(value),
      value: (value) => profiles.model.value(value),
      chunks: (value) => profiles.model.chunks(value),
    };
    const spiRedactor: SpiRedactor = { value: (value) => profiles.journal.value(value) };
    const chipRedactor = {
      text(value: string) {
        try {
          return redactSpiText(value, spiRedactor);
        } catch {
          return "Context chip withheld.";
        }
      },
    };
    const remember = (token: string) => {
      if (secrets.has(token)) return;
      secrets.add(token);
      profiles = createToolOutputRedactor(secrets);
    };
    let adapter: Promise<CopilotThreadAdapter> | undefined;
    const getAdapter = () => {
      adapter ??= options
        .runtime(remember)
        .then(
          (runtime) =>
            new CopilotThreadAdapter(
              runtime,
              {
                get: (id) => read.get(id)?.session_id as string | undefined,
                set: (id, sessionId) => {
                  write.run(id, sessionId);
                },
              },
              modelRedactor,
            ),
        )
        .catch((error: unknown) => {
          adapter = undefined;
          throw error;
        });
      return adapter;
    };
    let workspaces: ScopeWorkspaces | undefined;
    const tools = spiReadTools(options.savedSweep, spiRedactor);
    const engine = new ThreadEngine<Tool>(db, {
      runtime: { run: async (input, events) => (await getAdapter()).run(input, events) },
      workspace: {
        async resolve({ threadId, thread, signal }): Promise<AskingTurnWorkspace> {
          const scope = scopes.lookup(thread.scope);
          if (!scope) throw new Error("Thread scope is unavailable.");
          const git = await options.git();
          workspaces ??= options.workspaces(git);
          const prepared = await workspaces.prepareThread(db, scope, threadId, thread.landsIn, {
            signal,
          });
          if (!prepared.ok) throw new Error(prepared.error);
          signal.throwIfAborted();
          const temp = join(await git.dataRoot(), "thread-temp", threadId);
          await mkdir(temp, { recursive: true, mode: 0o700 });
          const tempPath = await realpath(temp);
          if (prepared.workspace.kind === "program")
            return { cwd: tempPath, sandbox: { tempPath } };
          const { cwd } = prepared.workspace;
          const isWorktree = prepared.workspace.kind === "worktree";
          const target = isWorktree
            ? {
                clone: prepared.workspace.clonePath,
                worktree: {
                  id: prepared.workspace.worktreeId,
                  cwd,
                },
              }
            : { clone: cwd };
          const head = await git.head(target, { signal });
          const sha = head.ok ? head.data.trim() : "";
          return {
            cwd,
            sandbox: {
              clonePath: isWorktree ? prepared.workspace.clonePath : cwd,
              ...(isWorktree ? { worktreePath: cwd } : {}),
              tempPath,
            },
            reading: {
              head: /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sha) ? sha : "not known",
              ...(!isWorktree && prepared.workspace.fetchError
                ? {
                    fetch: {
                      state: "not fetched",
                      ...prepared.workspace.fetchError,
                    },
                  }
                : { fetch: { state: "fetched" } }),
            },
          };
        },
      },
      context: threadContext({ scopes, tools: offeredTools(tools), redactor: chipRedactor }),
      tools: spiToolProvider(tools),
      redactor: {
        text: (value) => profiles.journal.text(value),
        value: (value) => profiles.journal.value(value),
        chunks: (value) => profiles.journal.chunks(value),
        assistantText: () => {
          let writer: ReturnType<typeof profiles.journal.assistantText> | undefined;
          return {
            push: (value) => {
              writer ??= profiles.journal.assistantText();
              return writer.push(value);
            },
            flush: () => writer?.flush() ?? "",
          };
        },
      },
      onUnreadableThread: () => console.error("A damaged thread journal was set aside."),
    });
    const settlement = setInterval(
      () => {
        try {
          if (engine.autoSettle() > 0) options.onThreadsChanged?.();
        } catch (error) {
          console.error("Automatic thread settlement could not finish.", error);
        }
      },
      60 * 60 * 1000,
    );
    settlement.unref();
    const scopeFor = (id: string) => {
      const scope = scopes.lookup(engine.read(id).thread.scope);
      if (!scope) throw new Error("Thread scope is unavailable.");
      return scope;
    };
    let stopping: Promise<void> | undefined;
    return {
      engine,
      remember,
      chip: (id: string) => chipFromSweep(options.savedSweep, id, spiRedactor),
      redact: chipRedactor.text,
      land: async (id: string, request: Parameters<ScopeWorkspaces["land"]>[3]) => {
        return engine.transition(id, async () => {
          const git = await options.git();
          workspaces ??= options.workspaces(git);
          const result = await workspaces.land(db, scopeFor(id), id, request);
          if (!result.ok) return result;
          try {
            engine.land(id, result.landsIn);
          } catch (error) {
            await workspaces.rollbackLanding(db, id);
            throw error;
          }
          return result;
        });
      },
      delete: async (id: string) => {
        return engine.transition(id, async () => {
          const git = await options.git();
          workspaces ??= options.workspaces(git);
          const kept = await workspaces.keepWorktree(db, id);
          try {
            engine.delete(id);
          } catch (error) {
            if (kept) workspaces.restoreWorktree(db, id);
            throw error;
          }
          if (!kept) return undefined;
          return (await workspaces.reclaimWorktree(db, id)) ?? kept;
        });
      },
      worktrees: async () => {
        const git = await options.git();
        workspaces ??= options.workspaces(git);
        return workspaces.keptWorktrees(db);
      },
      reclaim: async (id: string, confirmedFiles: readonly string[] = []) => {
        const git = await options.git();
        workspaces ??= options.workspaces(git);
        return workspaces.reclaimWorktree(db, id, confirmedFiles);
      },
      stop: () => {
        stopping ??= Promise.resolve()
          .then(() => {
            clearInterval(settlement);
            return engine.shutdown();
          })
          .finally(async () => {
            try {
              if (adapter) {
                const controller = new AbortController();
                try {
                  await Promise.race([
                    adapter.then((instance) => instance.stop()),
                    setTimeout(1500, undefined, { signal: controller.signal }),
                  ]);
                } finally {
                  controller.abort();
                }
              }
            } finally {
              lock.close();
            }
          });
        return stopping;
      },
    };
  } catch (error) {
    lock.close();
    throw error;
  }
}
