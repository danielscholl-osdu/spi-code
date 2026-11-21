// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Message } from "@spi-code/contracts";
import type { Exec, ExecResult } from "@spi-code/core";
import type { ThreadDefinition, ThreadLanding, ThreadRequest } from "@spi-code/threads";
import type { PrivilegedGit, WorktreeTarget } from "../scopes/git.js";
import type { RepositoryScope, Scope } from "../scopes/registry.js";
import { type ChangesGit, readChanges } from "./changes.js";

export type PublicationGit = ChangesGit & Pick<PrivilegedGit, "addRemote" | "push" | "remoteHead">;

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
      repositoryUrl: string;
      sourceRepository: string;
      sourceProjectId?: number | string;
      base: string;
      forgeHost: string;
      previousHead?: string;
      request?: ThreadRequest;
    };

type GitLabProject = {
  id?: unknown;
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

type GitLabRequest = {
  source_branch?: unknown;
  source_project_id?: unknown;
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
  forgeCwd?: string,
): Promise<PreparedPublication> {
  const upstream = scope.upstream;
  if (!upstream) return unavailable("This scope has no upstream project.");
  const projectUrl = upstream.url.replace(/\.git$/u, "");
  const host = new URL(projectUrl).hostname;
  const project = await exec.runJSON<GitLabProject>(
    "glab",
    ["api", `projects/${encodeURIComponent(upstream.repo)}`, "--hostname", host],
    forgeCwd ? { cwd: forgeCwd } : {},
  );
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
    const sourceProjectId = value.id;
    if (typeof sourceProjectId !== "number" && typeof sourceProjectId !== "string")
      return {
        ok: false,
        publication: {
          state: "not read",
          reason: "The upstream project's identity was not read.",
        },
      };
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
      repositoryUrl: projectUrl,
      sourceRepository: upstream.repo,
      sourceProjectId,
      base: defaultBranch,
      forgeHost: new URL(projectUrl).host,
    };
  }
  const repository = upstream.repo.split("/").at(-1) ?? upstream.repo;
  const forks = await exec.runJSON<unknown>(
    "glab",
    [
      "api",
      `projects?owned=true&search=${encodeURIComponent(repository)}&per_page=100`,
      "--hostname",
      host,
    ],
    forgeCwd ? { cwd: forgeCwd } : {},
  );
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
  const sourceProjectId = fork.id;
  if (typeof sourceProjectId !== "number" && typeof sourceProjectId !== "string")
    return {
      ok: false,
      publication: {
        state: "not read",
        reason: "The operator's GitLab fork identity was not read.",
      },
    };
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
    repositoryUrl: projectUrl,
    sourceRepository: fork.path_with_namespace,
    sourceProjectId,
    base: defaultBranch,
    forgeHost: new URL(projectUrl).host,
  };
}

async function existingGitLabRequest(
  exec: Exec,
  scope: RepositoryScope,
  landing: Extract<ThreadLanding, { target: "request" }>,
  forgeCwd?: string,
): Promise<PreparedPublication> {
  const upstream = scope.upstream;
  if (!upstream) return unavailable("This scope has no upstream project.");
  const projectUrl = upstream.url.replace(/\.git$/u, "");
  const host = new URL(projectUrl).hostname;
  const details = await exec.runJSON<GitLabRequest>(
    "glab",
    [
      "api",
      `projects/${encodeURIComponent(upstream.repo)}/merge_requests/${landing.requestNumber}`,
      "--hostname",
      host,
    ],
    forgeCwd ? { cwd: forgeCwd } : {},
  );
  if (!details.ok)
    return {
      ok: false,
      publication: {
        state: "not read",
        reason: `The existing merge request was not read. ${details.error}`,
      },
    };
  if (details.data.source_branch !== landing.sourceBranch)
    return unavailable("The existing merge request no longer names this source branch.");
  const sourceProjectId = details.data.source_project_id;
  if (typeof sourceProjectId !== "number" && typeof sourceProjectId !== "string")
    return {
      ok: false,
      publication: {
        state: "not read",
        reason: "The existing merge request's source project was not read.",
      },
    };
  const source = await exec.runJSON<GitLabProject>(
    "glab",
    ["api", `projects/${encodeURIComponent(String(sourceProjectId))}`, "--hostname", host],
    forgeCwd ? { cwd: forgeCwd } : {},
  );
  if (!source.ok)
    return {
      ok: false,
      publication: {
        state: "not read",
        reason: `The merge request's source project was not read. ${source.error}`,
      },
    };
  const sourcePath = source.data.path_with_namespace;
  if (typeof sourcePath !== "string")
    return {
      ok: false,
      publication: {
        state: "not read",
        reason: "The merge request's source project was not read.",
      },
    };
  if (sourcePath === upstream.repo) {
    const destination = await upstreamPublication(exec, scope, forgeCwd);
    if (!destination.ok) return destination;
    if (destination.publication.remote !== "upstream")
      return unavailable(
        "The merge request's source branch is in upstream, but this sign-in cannot push there.",
      );
    return { ...destination, previousHead: landing.head };
  }
  if (!validFork(source.data, upstream.repo, host) || accessLevel(source.data) < 30) {
    return unavailable("The merge request's source project is not a fork this sign-in can push.");
  }
  const project = await exec.runJSON<GitLabProject>(
    "glab",
    ["api", `projects/${encodeURIComponent(upstream.repo)}`, "--hostname", host],
    forgeCwd ? { cwd: forgeCwd } : {},
  );
  if (!project.ok)
    return {
      ok: false,
      publication: {
        state: "not read",
        reason: `The upstream project was not read. ${project.error}`,
      },
    };
  const base =
    typeof project.data.default_branch === "string" && project.data.default_branch
      ? project.data.default_branch
      : "";
  if (!base)
    return {
      ok: false,
      publication: {
        state: "not read",
        reason: "The upstream project's default branch was not read.",
      },
    };
  return {
    ok: true,
    publication: {
      state: "ready",
      remote: "operator",
      branch: landing.branch,
      base,
      opens: "none",
    },
    remoteUrl: `${source.data.web_url}.git`,
    repository: upstream.repo,
    repositoryUrl: projectUrl,
    sourceRepository: sourcePath,
    sourceProjectId,
    base,
    forgeHost: new URL(projectUrl).host,
    previousHead: landing.head,
  };
}

/** Reads the destination without touching a repository; used before the Thread tab's button. */
export async function preparePublication(
  exec: Exec,
  scope: Scope,
  thread: Readonly<ThreadDefinition>,
  forgeCwd?: string,
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
      repositoryUrl: scope.origin.url.replace(/\.git$/u, ""),
      sourceRepository: scope.origin.repo,
      base: "main",
      forgeHost: new URL(scope.origin.url).host,
      ...(thread.pushedHead ? { previousHead: thread.pushedHead } : {}),
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
      repositoryUrl: scope.origin.url.replace(/\.git$/u, ""),
      sourceRepository: scope.origin.repo,
      base: "fork_integration",
      forgeHost: new URL(scope.origin.url).host,
      ...(thread.pushedHead ? { previousHead: thread.pushedHead } : {}),
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
      const upstream = await existingGitLabRequest(exec, scope, landing, forgeCwd);
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
      repositoryUrl:
        landing.forge === "github"
          ? scope.origin.url.replace(/\.git$/u, "")
          : (destination?.repositoryUrl ?? ""),
      sourceRepository:
        landing.forge === "github"
          ? landing.repository
          : (destination?.sourceRepository ?? landing.repository),
      ...(destination?.sourceProjectId !== undefined
        ? { sourceProjectId: destination.sourceProjectId }
        : {}),
      ...(destination?.remoteUrl ? { remoteUrl: destination.remoteUrl } : {}),
      base: upstreamDefault ?? "main",
      forgeHost:
        landing.forge === "github"
          ? new URL(scope.origin.url).host
          : (destination?.forgeHost ?? ""),
      previousHead: thread.pushedHead ?? destination?.previousHead ?? landing.head,
      request,
    };
  }
  const upstream = await upstreamPublication(exec, scope, forgeCwd);
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
    ...(thread.pushedHead ? { previousHead: thread.pushedHead } : {}),
    ...(thread.request ? { request: thread.request } : {}),
  };
}

function parsedRequest(
  text: string,
  forge: ReadyPublication["opens"],
  prepared: Extract<PreparedPublication, { ok: true }>,
): ThreadRequest | undefined {
  const urls = text.match(/https:\/\/[^\s"'<>]+/gu) ?? [];
  for (const candidate of urls) {
    try {
      const url = new URL(candidate);
      if (
        url.protocol !== "https:" ||
        url.host !== prepared.forgeHost ||
        url.username ||
        url.password
      )
        continue;
      const escaped = prepared.repository.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const match =
        forge === "pull-request"
          ? new RegExp(`^/${escaped}/pull/(\\d+)/?$`, "u").exec(url.pathname)
          : new RegExp(`^/${escaped}/-/merge_requests/(\\d+)/?$`, "u").exec(url.pathname);
      const number = Number(match?.[1]);
      if (!Number.isSafeInteger(number) || number <= 0) continue;
      return {
        forge: forge === "pull-request" ? "github" : "gitlab",
        repository: prepared.repository,
        requestNumber: number,
        url: url.toString(),
      };
    } catch {
      // Try the next URL; command output is not a trusted URL source.
    }
  }
  return undefined;
}

async function existingRequest(
  exec: Exec,
  prepared: Extract<PreparedPublication, { ok: true }>,
  forgeCwd: string,
): Promise<{ ok: true; request?: ThreadRequest } | { ok: false; reason: string }> {
  const { publication } = prepared;
  const listed = await exec.runJSON<unknown>(
    publication.opens === "pull-request" ? "gh" : "glab",
    publication.opens === "pull-request"
      ? [
          "pr",
          "list",
          "--repo",
          prepared.repository,
          "--head",
          publication.branch,
          "--base",
          prepared.base,
          "--state",
          "open",
          "--json",
          "url,number,isCrossRepository,headRepositoryOwner",
        ]
      : [
          "mr",
          "list",
          "--repo",
          prepared.repositoryUrl,
          "--source-branch",
          publication.branch,
          "--target-branch",
          prepared.base,
          "--output",
          "json",
        ],
    { cwd: forgeCwd },
  );
  if (!listed.ok)
    return { ok: false, reason: `The branch's request was not read. ${listed.error}` };
  if (!Array.isArray(listed.data))
    return { ok: false, reason: "The branch's open request was not read." };
  let foundStranger = false;
  for (const entry of listed.data) {
    if (!object(entry)) return { ok: false, reason: "The branch's open request was not read." };
    const url = entry.url ?? entry.web_url;
    if (typeof url !== "string")
      return { ok: false, reason: "The branch's open request was not read." };
    const request = parsedRequest(url, publication.opens, prepared);
    if (!request) return { ok: false, reason: "The branch's open request was not read." };
    if (publication.opens === "pull-request") {
      const owner = entry.headRepositoryOwner;
      const expectedOwner = prepared.sourceRepository.split("/")[0]?.toLowerCase();
      const expectedCrossRepository =
        prepared.sourceRepository.toLowerCase() !== prepared.repository.toLowerCase();
      if (
        !object(owner) ||
        typeof owner.login !== "string" ||
        typeof entry.isCrossRepository !== "boolean" ||
        owner.login.toLowerCase() !== expectedOwner ||
        entry.isCrossRepository !== expectedCrossRepository
      ) {
        foundStranger = true;
        continue;
      }
    } else {
      const sourceProjectId = entry.source_project_id;
      if (
        (typeof sourceProjectId !== "number" && typeof sourceProjectId !== "string") ||
        prepared.sourceProjectId === undefined ||
        String(sourceProjectId) !== String(prepared.sourceProjectId)
      ) {
        foundStranger = true;
        continue;
      }
    }
    return { ok: true, request };
  }
  if (foundStranger)
    return {
      ok: false,
      reason: "The branch's request did not match this push's source.",
    };
  return { ok: true };
}

/** Reads the remote head into the publication the Thread tab last showed. */
export async function observePublication(
  git: Pick<PublicationGit, "remoteHead">,
  target: WorktreeTarget,
  prepared: PreparedPublication,
): Promise<Publication> {
  if (!prepared.ok) return prepared.publication;
  const observed = await git.remoteHead(
    target,
    prepared.publication.remote,
    prepared.publication.branch,
  );
  if (!observed.ok)
    return {
      state: "not read",
      reason: `The remote branch was not read. ${resultError(observed, "Git failed.")}`,
    };
  if (observed.data === null && prepared.previousHead !== undefined) {
    return {
      state: "unavailable",
      reason: "The remote branch was deleted. Update the thread's landing before pushing.",
    };
  }
  return { ...prepared.publication, observedHead: observed.data };
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
  displayedRemoteHead: string | null,
  prepared: Extract<PreparedPublication, { ok: true }>,
  forgeCwd: string,
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
  if (observed.data !== displayedRemoteHead) {
    return {
      publication: {
        outcome: "refused",
        reason:
          displayedRemoteHead !== null && observed.data === null
            ? "The remote branch was deleted since the Thread tab read it. Update it before pushing."
            : "The remote branch moved since the Thread tab read it. Update it before pushing.",
      },
    };
  }
  const pushed = await git.push(target, {
    remote: publication.remote,
    source: displayedHead,
    destination: `refs/heads/${publication.branch}`,
    expectedHead: observed.data,
  });
  if (!pushed.ok)
    return {
      publication:
        "ancestryRefused" in pushed
          ? { outcome: "refused", reason: pushed.error }
          : gitOutcome(pushed, "Pushing the branch"),
    };
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
  const existing = await existingRequest(exec, prepared, forgeCwd);
  if (!existing.ok)
    return {
      publication: {
        outcome: "not known",
        reason: existing.reason,
      },
      pushedHead: displayedHead,
    };
  if (existing.request)
    return {
      publication: {
        outcome: "published",
        head: displayedHead,
        request: existing.request,
      },
      request: existing.request,
      pushedHead: displayedHead,
    };
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
          { cwd: forgeCwd },
        )
      : await exec.runText(
          "glab",
          [
            "mr",
            "create",
            "--repo",
            prepared.repositoryUrl,
            "--head",
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
          { cwd: forgeCwd },
        );
  if (!created.ok)
    return {
      publication: gitOutcome(created, "Opening the draft request"),
      pushedHead: displayedHead,
    };
  const request = parsedRequest(created.data, publication.opens, prepared);
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
