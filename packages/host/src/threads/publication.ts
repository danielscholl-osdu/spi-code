// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Message } from "@spi-code/contracts";
import type { Exec, ExecResult } from "@spi-code/core";
import type { ThreadDefinition, ThreadLanding, ThreadRequest } from "@spi-code/threads";
import type { PrivilegedGit, WorktreeTarget } from "../scopes/git.js";
import type { RepositoryScope, Scope } from "../scopes/registry.js";
import { type ChangesGit, readChanges } from "./changes.js";

export type PublicationGit = ChangesGit &
  Pick<PrivilegedGit, "addRemote" | "isAncestor" | "push" | "remoteHead">;

type Publication = Extract<
  Message,
  { type: "thread.publication.result" }
>["payload"]["publication"];
export type PublicationOutcome = Extract<
  Message,
  { type: "thread.published" }
>["payload"]["publication"];
type ReadyPublication = Extract<Publication, { state: "ready" }>;

export type PreparedPublication =
  | { ok: false; publication: Exclude<Publication, ReadyPublication> }
  | {
      ok: true;
      publication: ReadyPublication;
      remoteUrl?: string;
      repository: string;
      sourceRepository: string;
      base: string;
      observedHead?: string;
      request?: ThreadRequest;
    };

type GitLabProject = {
  default_branch?: unknown;
  path_with_namespace?: unknown;
  web_url?: unknown;
  http_url_to_repo?: unknown;
  permissions?: {
    project_access?: { access_level?: unknown };
    group_access?: { access_level?: unknown };
  };
  forked_from_project?: { path_with_namespace?: unknown };
};

const sha = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function resultError(result: ExecResult<unknown>, fallback: string): string {
  return result.ok ? fallback : result.error;
}

function protectedBranch(branch: string, upstreamDefault?: string): boolean {
  return ["main", "fork_integration", upstreamDefault].some(
    (protectedBranch) => protectedBranch && branch === protectedBranch,
  );
}

export function requestFromLanding(
  landing: Extract<ThreadLanding, { target: "request" }>,
  scope: RepositoryScope,
): ThreadRequest | undefined {
  const url =
    landing.forge === "github"
      ? scope.origin.url.replace(/\.git$/u, "")
      : scope.upstream?.url.replace(/\.git$/u, "");
  if (!url) return undefined;
  return {
    forge: landing.forge,
    repository: landing.repository,
    requestNumber: landing.requestNumber,
    url:
      landing.forge === "github"
        ? `${url}/pull/${landing.requestNumber}`
        : `${url}/-/merge_requests/${landing.requestNumber}`,
  };
}

function unavailable(reason: string, url?: string): PreparedPublication {
  return { ok: false, publication: { state: "unavailable", reason, ...(url ? { url } : {}) } };
}

const accessLevel = (project: GitLabProject): number => {
  const levels = [
    project.permissions?.project_access?.access_level,
    project.permissions?.group_access?.access_level,
  ];
  return Math.max(0, ...levels.map((level) => (typeof level === "number" ? level : 0)));
};

function httpsProject(value: unknown, host: string): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === host && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validFork(
  value: unknown,
  upstream: string,
  host: string,
): value is GitLabProject & { path_with_namespace: string; web_url: string } {
  return (
    object(value) &&
    typeof value.path_with_namespace === "string" &&
    typeof value.web_url === "string" &&
    httpsProject(value.web_url, host) &&
    object(value.forked_from_project) &&
    value.forked_from_project.path_with_namespace === upstream
  );
}

async function upstreamPublication(
  exec: Exec,
  scope: RepositoryScope,
): Promise<PreparedPublication> {
  const upstream = scope.upstream;
  if (!upstream) return unavailable("This scope has no upstream project.");
  const projectUrl = upstream.url.replace(/\.git$/u, "");
  const host = new URL(projectUrl).hostname;
  const project = await exec.runJSON<GitLabProject>("glab", [
    "api",
    `projects/${encodeURIComponent(upstream.repo)}`,
  ]);
  if (!project.ok)
    return {
      ok: false,
      publication: {
        state: "not read",
        reason: `The upstream project was not read. ${project.error}`,
      },
    };
  const value = project.data;
  const defaultBranch =
    typeof value.default_branch === "string" && value.default_branch ? value.default_branch : "";
  if (!defaultBranch)
    return {
      ok: false,
      publication: {
        state: "not read",
        reason: "The upstream project's default branch was not read.",
      },
    };
  if (accessLevel(value) >= 30) {
    return {
      ok: true,
      publication: {
        state: "ready",
        remote: "upstream",
        branch: "",
        base: defaultBranch,
        opens: "merge-request",
      },
      repository: upstream.repo,
      sourceRepository: upstream.repo,
      base: defaultBranch,
    };
  }
  const repository = upstream.repo.split("/").at(-1) ?? upstream.repo;
  const forks = await exec.runJSON<unknown>("glab", [
    "api",
    `projects?owned=true&search=${encodeURIComponent(repository)}&per_page=100`,
  ]);
  if (!forks.ok)
    return {
      ok: false,
      publication: {
        state: "not read",
        reason: `The operator's GitLab forks were not read. ${forks.error}`,
      },
    };
  if (!Array.isArray(forks.data))
    return {
      ok: false,
      publication: { state: "not read", reason: "The operator's GitLab forks were not read." },
    };
  const fork = forks.data.find((entry) => validFork(entry, upstream.repo, host)) as
    | (GitLabProject & { path_with_namespace: string; web_url: string })
    | undefined;
  if (!fork)
    return unavailable(
      "You cannot push to upstream, and your sign-in has no fork of it. SPI Code did not create one.",
      projectUrl,
    );
  return {
    ok: true,
    publication: {
      state: "ready",
      remote: "operator",
      branch: "",
      base: defaultBranch,
      opens: "merge-request",
    },
    remoteUrl: `${fork.web_url}.git`,
    repository: upstream.repo,
    sourceRepository: fork.path_with_namespace,
    base: defaultBranch,
  };
}

/** Reads the destination without touching a repository; used before the Thread tab's button. */
export async function preparePublication(
  exec: Exec,
  scope: Scope,
  thread: Readonly<ThreadDefinition>,
): Promise<PreparedPublication> {
  const landing = thread.landsIn;
  if (!landing || landing.target === "asking")
    return { ok: false, publication: { state: "asking" } };
  if (scope.kind === "program") return unavailable("Program threads have no repository to push.");
  if (protectedBranch(landing.branch))
    return unavailable(`Refusing to push protected branch ${landing.branch}.`);
  if (landing.target === "fork-main") {
    return {
      ok: true,
      publication: {
        state: "ready",
        remote: "origin",
        branch: landing.branch,
        base: "main",
        opens: thread.request ? "none" : "pull-request",
        ...(thread.request ? { request: thread.request } : {}),
      },
      repository: scope.origin.repo,
      sourceRepository: scope.origin.repo,
      base: "main",
      ...(thread.pushedHead ? { observedHead: thread.pushedHead } : {}),
      ...(thread.request ? { request: thread.request } : {}),
    };
  }
  if (landing.target === "fork-integration") {
    return {
      ok: true,
      publication: {
        state: "ready",
        remote: "origin",
        branch: landing.branch,
        base: "fork_integration",
        opens: thread.request ? "none" : "pull-request",
        ...(thread.request ? { request: thread.request } : {}),
      },
      repository: scope.origin.repo,
      sourceRepository: scope.origin.repo,
      base: "fork_integration",
      ...(thread.pushedHead ? { observedHead: thread.pushedHead } : {}),
      ...(thread.request ? { request: thread.request } : {}),
    };
  }
  if (landing.target === "request") {
    const request = thread.request ?? requestFromLanding(landing, scope);
    if (!request)
      return {
        ok: false,
        publication: { state: "not read", reason: "The request URL was not read." },
      };
    let destination = undefined as Extract<PreparedPublication, { ok: true }> | undefined;
    if (landing.forge === "gitlab") {
      const upstream = await upstreamPublication(exec, scope);
      if (!upstream.ok) return upstream;
      destination = upstream;
    }
    const upstreamDefault = destination?.base;
    if (protectedBranch(landing.branch, upstreamDefault))
      return unavailable(`Refusing to push protected branch ${landing.branch}.`, request.url);
    return {
      ok: true,
      publication: {
        state: "ready",
        remote:
          landing.forge === "github" ? "origin" : (destination?.publication.remote ?? "upstream"),
        branch: landing.branch,
        opens: "none",
        request,
      },
      repository: landing.repository,
      sourceRepository:
        landing.forge === "github"
          ? landing.repository
          : (destination?.sourceRepository ?? landing.repository),
      ...(destination?.remoteUrl ? { remoteUrl: destination.remoteUrl } : {}),
      base: upstreamDefault ?? "main",
      observedHead: thread.pushedHead ?? landing.head,
      request,
    };
  }
  const upstream = await upstreamPublication(exec, scope);
  if (!upstream.ok) return upstream;
  if (protectedBranch(landing.branch, upstream.base))
    return unavailable(`Refusing to push protected branch ${landing.branch}.`);
  return {
    ...upstream,
    publication: {
      ...upstream.publication,
      branch: landing.branch,
      opens: thread.request ? "none" : upstream.publication.opens,
      ...(thread.request ? { request: thread.request } : {}),
    },
    ...(thread.pushedHead ? { observedHead: thread.pushedHead } : {}),
    ...(thread.request ? { request: thread.request } : {}),
  };
}

function parsedRequest(
  text: string,
  forge: ReadyPublication["opens"],
  repository: string,
): ThreadRequest | undefined {
  const urls = text.match(/https:\/\/[^\s"'<>]+/gu) ?? [];
  for (const candidate of urls) {
    try {
      const url = new URL(candidate);
      const escaped = repository.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const pattern =
        forge === "pull-request"
          ? new RegExp(`^https://github\\.com/${escaped}/pull/(\\d+?)/?$`, "u")
          : new RegExp(`^https://[^/]+/${escaped}/-/merge_requests/(\\d+?)/?$`, "u");
      const match = pattern.exec(url.toString());
      const number = Number(match?.[1]);
      if (!Number.isSafeInteger(number) || number <= 0) continue;
      return {
        forge: forge === "pull-request" ? "github" : "gitlab",
        repository,
        requestNumber: number,
        url: url.toString(),
      };
    } catch {
      // Try the next URL; command output is not a trusted URL source.
    }
  }
  return undefined;
}

function gitOutcome(result: ExecResult<string>, operation: string): PublicationOutcome {
  return !result.ok &&
    result.code === null &&
    !/spawn .*ENOENT|not found|EACCES/iu.test(result.error)
    ? {
        outcome: "not known",
        reason: `${operation} may still have run. Read the branch before trying again.`,
      }
    : { outcome: "failed", reason: resultError(result, `${operation} did not finish.`) };
}

/** Pushes at the displayed head, then opens a draft only when the landing is not an existing request. */
export async function publishChanges(
  exec: Exec,
  git: PublicationGit,
  target: WorktreeTarget,
  threadId: string,
  title: string | undefined,
  baseHead: string,
  displayedHead: string,
  prepared: Extract<PreparedPublication, { ok: true }>,
): Promise<{
  publication: PublicationOutcome;
  request?: ThreadRequest;
  pushedHead?: string;
}> {
  const { publication } = prepared;
  if (protectedBranch(publication.branch, prepared.base))
    return {
      publication: {
        outcome: "refused",
        reason: `Refusing to push protected branch ${publication.branch}.`,
      },
    };
  if (!sha(displayedHead))
    return {
      publication: { outcome: "refused", reason: "The displayed commit is not a full head." },
    };
  const changes = await readChanges(git, target, baseHead);
  if (changes.state !== "read")
    return {
      publication: {
        outcome: "refused",
        reason: changes.state === "not read" ? changes.reason : "The worktree is still being read.",
      },
    };
  if (changes.head !== displayedHead)
    return {
      publication: {
        outcome: "refused",
        reason: "The branch head moved since the Thread tab read it. Refresh before publishing.",
      },
    };
  if (changes.uncommitted)
    return {
      publication: {
        outcome: "refused",
        reason: "Commit the worktree before pushing it.",
      },
    };
  if (changes.ahead === 0)
    return { publication: { outcome: "refused", reason: "There is no commit to push." } };
  if (prepared.remoteUrl) {
    const added = await git.addRemote(target, publication.remote, prepared.remoteUrl);
    if (!added.ok) return { publication: gitOutcome(added, "Adding the GitLab fork") };
  }
  const observed = await git.remoteHead(target, publication.remote, publication.branch);
  if (!observed.ok) return { publication: gitOutcome(observed, "Reading the remote branch") };
  if (prepared.observedHead !== undefined && observed.data !== prepared.observedHead) {
    return {
      publication: {
        outcome: "refused",
        reason:
          "The remote branch moved since the thread last observed it. Update it before pushing.",
      },
    };
  }
  if (observed.data) {
    const ancestor = await git.isAncestor(target, observed.data, displayedHead);
    if (!ancestor.ok) return { publication: gitOutcome(ancestor, "Checking the remote head") };
    if (!ancestor.data)
      return {
        publication: {
          outcome: "refused",
          reason:
            "The remote branch is not an ancestor of this commit. Update the branch before pushing.",
        },
      };
  }
  const pushed = await git.push(target, {
    remote: publication.remote,
    source: displayedHead,
    destination: `refs/heads/${publication.branch}`,
    ...(observed.data ? { expectedHead: observed.data } : {}),
  });
  if (!pushed.ok) return { publication: gitOutcome(pushed, "Pushing the branch") };
  if (publication.opens === "none") {
    return {
      publication: {
        outcome: "pushed",
        head: displayedHead,
        ...(prepared.request ? { request: prepared.request } : {}),
      },
      pushedHead: displayedHead,
      ...(prepared.request ? { request: prepared.request } : {}),
    };
  }
  const requestTitle = title?.trim() || `SPI Code thread ${threadId}`;
  const body = `Draft request for SPI Code thread ${threadId}.`;
  const created =
    publication.opens === "pull-request"
      ? await exec.runText(
          "gh",
          [
            "pr",
            "create",
            "--repo",
            prepared.repository,
            "--head",
            publication.branch,
            "--base",
            prepared.base,
            "--draft",
            "--title",
            requestTitle,
            "--body",
            body,
          ],
          { cwd: target.worktree.cwd },
        )
      : await exec.runText(
          "glab",
          [
            "mr",
            "create",
            "--repo",
            prepared.repository,
            "--source-project",
            prepared.sourceRepository,
            "--source-branch",
            publication.branch,
            "--target-branch",
            prepared.base,
            "--draft",
            "--title",
            requestTitle,
            "--description",
            body,
            "--yes",
          ],
          { cwd: target.worktree.cwd },
        );
  if (!created.ok)
    return {
      publication: gitOutcome(created, "Opening the draft request"),
      pushedHead: displayedHead,
    };
  const request = parsedRequest(created.data, publication.opens, prepared.repository);
  if (!request)
    return {
      publication: {
        outcome: "not known",
        reason:
          "The branch was pushed, but the request URL was not returned. Read the forge before opening another request.",
      },
      pushedHead: displayedHead,
    };
  return {
    publication: { outcome: "published", head: displayedHead, request },
    request,
    pushedHead: displayedHead,
  };
}
