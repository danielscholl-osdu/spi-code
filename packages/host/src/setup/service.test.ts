// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type Message,
  PROTOCOL_VERSION,
  type SetupSigninProgress,
  type SetupState,
} from "@spi-code/contracts";
import {
  cacheSchema,
  createContext,
  type Exec,
  emptyCache,
  type Facts,
  Sweeper,
} from "@spi-code/core";
import { ToolInstaller } from "@spi-code/tools";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { HostExec, type HostExecLog } from "../exec/host-exec.js";
import { openRunStore } from "../store/store.js";
import { SweepService } from "../sweep/service.js";
import {
  GITLAB_AREAS_REASON,
  type SetupGit,
  SetupService,
  type SetupServiceOptions,
} from "./service.js";

const GH_FIXTURE = `#!/bin/sh
here="$(cd "$(dirname "$0")" && pwd)"
mark="$here/../../signed-in"
case "$1 $2" in
  "auth status")
    if [ -f "$mark" ]; then
      printf 'github.com\\n  Logged in to github.com account fixture (keyring)\\n  - Active account: true\\n  - Token: gho_****\\n  - Token scopes: '"'"'repo'"'"', '"'"'workflow'"'"'\\n' >&2
      exit 0
    fi
    printf 'You are not logged into any GitHub hosts.\\n' >&2
    exit 1;;
  "auth login")
    printf '! First copy your one-time code: ABCD-1234\\nOpen this URL to continue in your web browser: https://github.com/login/device\\n' >&2
    : > "$mark"
    exit 0;;
esac
echo "spi-fixture-gh $*"
`;
const GH_STATUS_OK =
  "github.com\n  Logged in to github.com account fixture (keyring)\n  - Active account: true\n  - Token: gho_****\n  - Token scopes: 'repo', 'workflow'\n";

let directory: string;
let appData: string;
let server: Server | undefined;
let origin: string;
let archive: Buffer;
const services: SetupService[] = [];

beforeEach(async () => {
  server = undefined;
  directory = mkdtempSync(join(tmpdir(), "spi-setup-"));
  appData = join(directory, "app");
  const fixture = join(directory, "fixture");
  mkdirSync(join(fixture, "bin"), { recursive: true });
  writeFileSync(join(fixture, "bin", "gh"), GH_FIXTURE);
  chmodSync(join(fixture, "bin", "gh"), 0o755);
  // Relative paths: GNU tar from Git for Windows reads "C:" in an archive path as a remote host.
  execFileSync("tar", ["-czf", "gh.tar.gz", "-C", "fixture", "bin/gh"], { cwd: directory });
  archive = readFileSync(join(directory, "gh.tar.gz"));
  const listening = createServer((request, response) => {
    if (request.url === "/gh.tar.gz") response.end(archive);
    else response.writeHead(404).end();
  });
  server = listening;
  listening.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listening.once("listening", resolve));
  origin = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  const listening = server;
  if (listening) await new Promise<void>((resolve) => listening.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});

function installer(): ToolInstaller {
  const asset = (name: string, sha256: string) => ({
    "darwin-arm64": { url: `${origin}/${name}.tar.gz`, sha256 },
    "win32-x64": { url: `${origin}/${name}.tar.gz`, sha256 },
  });
  const sha = createHash("sha256").update(archive).digest("hex");
  return new ToolInstaller(
    appData,
    {
      tools: [
        { tool: "gh", version: "2.74.0", platforms: asset("gh", sha) },
        { tool: "glab", version: "1.74.0", platforms: asset("glab", "0".repeat(64)) },
      ],
    },
    "darwin-arm64",
  );
}

const git: SetupGit = {
  readiness: async () => ({ state: "ready", version: "2.45.0" }),
  install: async () => {},
};

function setup(overrides: Partial<SetupServiceOptions> & Pick<SetupServiceOptions, "exec">) {
  const sent: Message[] = [];
  const service = new SetupService({
    tools: async () => installer(),
    git: async () => git,
    probeSeat: async () => ({ kind: "seat-ok", models: ["auto"] }),
    refreshBudget: async () => ({ remaining: 4000, resetAt: null, deferredAreas: [] }),
    sweepStatus: () => ({ remaining: null, resetAt: null, deferredAreas: [] }),
    createSweep: () => ({ start: async () => true, stop: async () => {} }),
    onError: (error) => {
      throw error;
    },
    ...overrides,
  });
  services.push(service);
  service.connect((message) => sent.push(message));
  const states = () =>
    sent.flatMap((message) => (message.type === "setup.state" ? [message.payload] : []));
  const progress = () =>
    sent.flatMap((message) => (message.type === "setup.signin.progress" ? [message.payload] : []));
  return { service, sent, states, progress };
}

function row(state: SetupState | undefined, tool: string) {
  return state?.tools.find((entry) => entry.tool === tool);
}

function request(
  type: "setup.install" | "setup.signin",
  payload: { tool: string; token?: string },
) {
  return {
    version: PROTOCOL_VERSION,
    id: `req-${type}`,
    kind: "request",
    type,
    payload,
  } as Message;
}

function hostExec(tools: ToolInstaller, capturedPath = "/usr/bin:/bin"): HostExec {
  return new HostExec({
    appData,
    capturedPath,
    installer: tools,
    env: { HOME: directory, PATH: "/usr/bin:/bin" },
  });
}

/** An Exec that answers each call from `answer`, given the command and its arguments. */
function fakeExec(answer: (cmd: string, args: string[]) => string | undefined): Exec {
  return {
    runText: async (cmd, args) => {
      const data = answer(cmd, args);
      return data === undefined
        ? { ok: false, error: "absent", code: null }
        : { ok: true, data, exitCode: 0 };
    },
    runJSON: async () => ({ ok: false, error: "unused", code: null }),
  };
}

const managedGh = {
  readiness: async (tool: string) =>
    tool === "gh" ? { state: "ready" as const, version: "2.74.0" } : { state: "missing" as const },
  install: async () => {},
};

const checkRequest = {
  version: PROTOCOL_VERSION,
  id: "req-setup.check",
  kind: "request",
  type: "setup.check",
  payload: {},
} as const;

it("checks every tool and auth scope, bypasses the cached seat, and publishes a refreshed budget and completion time", async () => {
  let now = new Date("2026-11-08T15:00:00Z");
  const calls: string[] = [];
  const exec = fakeExec((cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "gh" && args[1] === "status") return GH_STATUS_OK;
    if (cmd === "gh" && args[1] === "token") return "gho_fixture";
    if (cmd === "glab" && args[1] === "status") return "Logged in to fixture";
    if (cmd === "glab" && args[0] === "api") return '{"scopes":["api"]}';
    return undefined;
  });
  const readiness = vi.fn(async (_tool: string) => ({
    state: "ready" as const,
    version: "2.74.0",
  }));
  const gitReadiness = vi.fn(git.readiness);
  const probeSeat = vi
    .fn<SetupServiceOptions["probeSeat"]>()
    .mockResolvedValueOnce({ kind: "seat-ok", models: ["auto"] })
    .mockResolvedValue({ kind: "no-seat", reason: "The seat was removed." });
  const refreshBudget = vi.fn(async () => ({
    remaining: 1234,
    resetAt: "2026-11-08T16:00:00Z",
  }));
  const { service, states, sent } = setup({
    exec,
    tools: async () => ({ readiness, install: async () => {} }),
    git: async () => ({ ...git, readiness: gitReadiness }),
    probeSeat,
    refreshBudget,
    clock: { now: () => now },
  });
  await service.refresh();
  expect(probeSeat).toHaveBeenCalledOnce();
  expect(refreshBudget).not.toHaveBeenCalled();
  const previousTime = states().at(-1)?.checkedAt;
  calls.length = 0;
  readiness.mockClear();
  gitReadiness.mockClear();
  now = new Date("2026-11-08T15:05:01Z");

  await service.routes["setup.check"]?.(checkRequest, () => {});

  expect(gitReadiness).toHaveBeenCalledOnce();
  expect(readiness.mock.calls.map(([tool]) => tool)).toEqual(["gh", "glab"]);
  expect(calls).toEqual(
    expect.arrayContaining([
      "gh auth status --hostname github.com",
      "gh auth token --hostname github.com",
      "glab auth status --hostname community.opengroup.org",
      "glab api personal_access_tokens/self --hostname community.opengroup.org",
    ]),
  );
  expect(probeSeat).toHaveBeenCalledTimes(2);
  expect(row(states().at(-1), "copilot")).toMatchObject({
    state: "no-seat",
    reason: "The seat was removed.",
  });
  expect(refreshBudget).toHaveBeenCalledOnce();
  expect(sent).toContainEqual(
    expect.objectContaining({
      type: "sweep.status",
      payload: { remaining: 1234, resetAt: "2026-11-08T16:00:00Z", deferredAreas: [] },
    }),
  );
  expect(states().at(-1)?.checkedAt).toBe("2026-11-08T15:05:01.000Z");
  expect(states().at(-1)?.checkedAt).not.toBe(previousTime);
});

it("collapses concurrent check requests into one probe, even behind an ordinary refresh", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const readiness = vi.fn(async () => {
    await held;
    return { state: "ready" as const, version: "2.74.0" };
  });
  const probeSeat = vi.fn(async () => ({ kind: "seat-ok" as const, models: ["auto"] }));
  const refreshBudget = vi.fn(async () => ({
    remaining: 4000,
    resetAt: null,
    deferredAreas: [],
  }));
  const { service, states } = setup({
    exec: fakeExec((cmd, args) =>
      cmd === "gh" && args[1] === "status" ? GH_STATUS_OK : undefined,
    ),
    tools: async () => ({ readiness, install: async () => {} }),
    probeSeat,
    refreshBudget,
    clock: { now: () => new Date("2026-11-08T15:00:00Z") },
  });
  const first = service.routes["setup.check"]?.(checkRequest, () => {});
  const second = service.routes["setup.check"]?.({ ...checkRequest, id: "second" }, () => {});
  release();
  await Promise.all([first, second]);
  expect(readiness).toHaveBeenCalledTimes(4);
  expect(probeSeat).toHaveBeenCalledTimes(2);
  expect(refreshBudget).toHaveBeenCalledOnce();
  expect(states()).toHaveLength(2);

  readiness.mockClear();
  probeSeat.mockClear();
  refreshBudget.mockClear();
  const third = service.routes["setup.check"]?.(checkRequest, () => {});
  const fourth = service.routes["setup.check"]?.({ ...checkRequest, id: "fourth" }, () => {});
  await Promise.all([third, fourth]);
  expect(readiness).toHaveBeenCalledTimes(2);
  expect(probeSeat).toHaveBeenCalledOnce();
  expect(refreshBudget).toHaveBeenCalledOnce();
  expect(states()).toHaveLength(3);
});

it("reports an unavailable budget without retaining stale points, and retries on the next check", async () => {
  const onError = vi.fn();
  const refreshBudget = vi
    .fn<SetupServiceOptions["refreshBudget"]>()
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValue({ remaining: 3000, resetAt: null });
  const deferredAreas = [{ area: "security", reason: "insufficient budget" }];
  const { service, sent, states } = setup({
    exec: fakeExec((cmd, args) =>
      cmd === "gh" && args[1] === "status" ? GH_STATUS_OK : undefined,
    ),
    tools: async () => managedGh,
    refreshBudget,
    sweepStatus: () => ({ remaining: 1000, resetAt: null, floor: 75, deferredAreas }),
    onError,
  });
  await service.refresh();
  await service.routes["setup.check"]?.(checkRequest, () => {});
  expect(onError).toHaveBeenCalledOnce();
  expect(sent).toContainEqual(
    expect.objectContaining({
      type: "sweep.status",
      payload: {
        remaining: null,
        resetAt: null,
        floor: 75,
        deferredAreas,
      },
    }),
  );
  expect(states().at(-1)?.checkedAt).toBeDefined();
  await service.routes["setup.check"]?.(checkRequest, () => {});
  expect(refreshBudget).toHaveBeenCalledTimes(2);
  expect(sent.filter(({ type }) => type === "sweep.status").at(-1)).toMatchObject({
    payload: { remaining: 3000, floor: 75, deferredAreas },
  });
});

it("completes a check from a fallback base when the stored sweep status cannot be read", async () => {
  const onError = vi.fn();
  const unreadable = new Error("stored snapshot is unreadable");
  const sweepStatus = vi.fn<SetupServiceOptions["sweepStatus"]>(() => {
    throw unreadable;
  });
  const { service, sent, states } = setup({
    exec: fakeExec((cmd, args) =>
      cmd === "gh" && args[1] === "status" ? GH_STATUS_OK : undefined,
    ),
    tools: async () => managedGh,
    refreshBudget: async () => ({ remaining: 2500, resetAt: "2026-11-08T16:00:00Z" }),
    sweepStatus,
    onError,
  });
  await service.refresh();
  const before = states().length;

  await service.routes["setup.check"]?.(checkRequest, () => {});

  expect(sweepStatus).toHaveBeenCalledOnce();
  expect(onError).toHaveBeenCalledExactlyOnceWith(unreadable);
  expect(states()).toHaveLength(before + 1);
  expect(states().at(-1)?.checkedAt).toBeDefined();
  expect(sent.filter(({ type }) => type === "sweep.status")).toEqual([
    expect.objectContaining({
      payload: { remaining: 2500, resetAt: "2026-11-08T16:00:00Z", deferredAreas: [] },
    }),
  ]);
});

it("posts checked state before a bounded budget read and leaves ordinary refreshes unblocked", async () => {
  vi.useFakeTimers();
  const refreshBudget = vi.fn<SetupServiceOptions["refreshBudget"]>(() => new Promise(() => {}));
  const onError = vi.fn();
  const { service, states } = setup({
    exec: fakeExec((cmd, args) =>
      cmd === "gh" && args[1] === "status" ? GH_STATUS_OK : undefined,
    ),
    tools: async () => managedGh,
    refreshBudget,
    onError,
  });
  try {
    await service.refresh();
    const completion = vi.fn();
    let done = false;
    const check = Promise.resolve(service.routes["setup.check"]?.(checkRequest, completion)).then(
      () => {
        done = true;
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(states()).toHaveLength(2);
    expect(states().at(-1)?.checkedAt).toBeDefined();
    expect(done).toBe(false);
    expect(completion).not.toHaveBeenCalled();
    await service.refresh();
    await vi.advanceTimersByTimeAsync(5000);
    await check;
    expect(done).toBe(true);
    expect(completion).toHaveBeenCalledExactlyOnceWith({
      version: PROTOCOL_VERSION,
      id: checkRequest.id,
      kind: "event",
      type: "setup.state",
      payload: service.current,
    });
    expect(onError).toHaveBeenCalledOnce();
    expect(refreshBudget.mock.calls[0]?.[0].aborted).toBe(true);
  } finally {
    await service.stop();
    vi.useRealTimers();
  }
});

it("merges fresh budget figures into the latest sweep floor and deferred areas", async () => {
  let release: (rate: { remaining: number; resetAt: string | null }) => void = () => {};
  const held = new Promise<{ remaining: number; resetAt: string | null }>((resolve) => {
    release = resolve;
  });
  let latest = {
    remaining: 1000,
    resetAt: null,
    floor: 75,
    deferredAreas: [] as { area: string; reason: string }[],
  };
  const { service, sent } = setup({
    exec: fakeExec((cmd, args) =>
      cmd === "gh" && args[1] === "status" ? GH_STATUS_OK : undefined,
    ),
    tools: async () => managedGh,
    refreshBudget: () => held,
    sweepStatus: () => latest,
  });
  await service.refresh();
  const check = service.routes["setup.check"]?.(checkRequest, () => {});
  await vi.waitFor(() => expect(service.current?.checkedAt).toBeDefined());
  latest = {
    remaining: 10,
    resetAt: null,
    floor: 125,
    deferredAreas: [{ area: "radar", reason: "insufficient budget" }],
  };
  release({ remaining: 1234, resetAt: "2026-11-08T16:00:00Z" });
  await check;
  expect(sent.at(-1)).toMatchObject({
    type: "sweep.status",
    payload: { ...latest, remaining: 1234, resetAt: "2026-11-08T16:00:00Z" },
  });
});

it("upgrades an already queued ordinary refresh when a check arrives behind it", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const readiness = vi.fn(managedGh.readiness);
  const probeSeat = vi.fn(async () => ({ kind: "seat-ok" as const, models: ["auto"] }));
  const refreshBudget = vi.fn(async () => ({ remaining: 1000, resetAt: null }));
  const { service } = setup({
    exec: fakeExec((cmd, args) =>
      cmd === "gh" && args[1] === "status" ? GH_STATUS_OK : undefined,
    ),
    tools: async () => ({ ...managedGh, readiness }),
    probeSeat,
    refreshBudget,
  });
  await service.refresh();
  readiness.mockImplementationOnce(async (tool) => {
    await held;
    return managedGh.readiness(tool);
  });
  const running = service.refresh();
  const queued = service.refresh();
  const check = service.routes["setup.check"]?.(checkRequest, () => {});
  release();
  await Promise.all([running, queued, check]);
  expect(probeSeat).toHaveBeenCalledTimes(2);
  expect(refreshBudget).toHaveBeenCalledOnce();
});

it("stamps only forced checks and carries their timestamp through ordinary refreshes", async () => {
  let now = new Date("2026-11-08T15:00:00Z");
  const { service, states } = setup({ exec: fakeExec(() => undefined), clock: { now: () => now } });
  await service.refresh();
  expect(service.current).not.toHaveProperty("checkedAt");
  await service.routes["setup.check"]?.(checkRequest, () => {});
  expect(service.current?.checkedAt).toBe(now.toISOString());
  now = new Date("2026-11-08T15:10:00Z");
  await service.refresh();
  expect(service.current?.checkedAt).toBe("2026-11-08T15:00:00.000Z");
  expect(states()).toHaveLength(2);
});

it.each(["missing", "signed-out"] as const)("skips budget reads when gh is %s", async (state) => {
  const refreshBudget = vi.fn();
  const onError = vi.fn();
  const { service } = setup({
    exec: fakeExec(() => (state === "signed-out" ? "" : undefined)),
    tools: async () =>
      state === "missing"
        ? { ...managedGh, readiness: async () => ({ state: "missing" as const }) }
        : managedGh,
    refreshBudget,
    onError,
  });
  await service.refresh();
  await service.routes["setup.check"]?.(checkRequest, () => {});
  expect(row(service.current, "gh")?.state).toBe(state);
  expect(refreshBudget).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
});

it.skipIf(process.platform === "win32")(
  "installs gh from the pinned download and runs the managed binary through HostExec",
  async () => {
    const tools = installer();
    mkdirSync(join(appData, "tools", "gh"), { recursive: true });
    writeFileSync(join(appData, "tools", "gh", "signed-in"), "");
    const exec = hostExec(tools);
    const { service, states } = setup({ exec, tools: async () => tools });
    await service.refresh();
    expect(row(states().at(-1), "gh")).toMatchObject({ state: "missing", action: "install" });

    await service.routes["setup.install"]?.(request("setup.install", { tool: "gh" }), () => {});

    const gh = states().map((state) => row(state, "gh")?.state);
    expect(gh).toEqual(["missing", "installing", "ready"]);
    expect(row(states().at(-1), "gh")).toMatchObject({
      version: "2.74.0",
      scopes: ["repo", "workflow"],
    });
    const result = await exec.runText("gh", ["--version"]);
    expect(result).toMatchObject({ ok: true, data: "spi-fixture-gh --version\n" });
    expect(await tools.binDir("gh")).toBe(join(appData, "tools", "gh", "2.74.0", "bin"));

    await service.routes["setup.install"]?.(request("setup.install", { tool: "glab" }), () => {});
    expect(row(states().at(-1), "glab")).toMatchObject({
      state: "failed",
      action: "install",
      reason: expect.stringContaining("HTTP 404"),
    });
  },
);

it.skipIf(process.platform === "win32")(
  "starts the SweepService once gh signs in with its scopes, and stops it when gh signs out",
  async () => {
    const tools = installer();
    await tools.install("gh");
    const exec = hostExec(tools);
    const path = join(directory, "store.sqlite");
    openRunStore(path).close();
    const db = new DatabaseSync(path);
    const starts: Promise<boolean>[] = [];
    const created = vi.fn();
    let sweep: SweepService | undefined;
    const { service, states, progress } = setup({
      exec,
      tools: async () => tools,
      createSweep: () => {
        created();
        const instance = new SweepService({
          db,
          fleet: "test",
          appData: directory,
          ctx: createContext({}),
          exec,
          factsSchema: z.custom<Facts>(),
          doctor: () => service.doctor(),
          onError: (error) => {
            throw error;
          },
          createSweeper: (options) =>
            new Sweeper({ ...options, areas: [], cacheSchema, emptyCache }),
        });
        sweep = instance;
        return {
          start: () => {
            const started = instance.start();
            starts.push(started);
            return started;
          },
          stop: () => instance.stop(),
        };
      },
    });
    try {
      await service.refresh();
      expect(row(states().at(-1), "gh")).toMatchObject({ state: "signed-out", action: "signin" });
      expect(states().at(-1)).toMatchObject({
        watchReady: false,
        disabledReason: expect.stringContaining("gh is not signed in"),
      });
      expect(created).not.toHaveBeenCalled();

      await service.routes["setup.signin"]?.(request("setup.signin", { tool: "gh" }), () => {});

      expect(progress().map(({ state }) => state)).toEqual([
        "starting",
        "device-code",
        "waiting",
        "completed",
      ]);
      expect(progress()[1]).toMatchObject({ deviceCode: "ABCD-1234" });
      expect(row(states().at(-1), "gh")).toMatchObject({
        state: "ready",
        scopes: ["repo", "workflow"],
      });
      expect(states().at(-1)).toMatchObject({ watchReady: true, disabledReason: null });
      expect(created).toHaveBeenCalledOnce();
      await expect(starts[0]).resolves.toBe(true);
      expect(sweep?.latest()).toBeDefined();

      await service.refresh();
      expect(created).toHaveBeenCalledOnce();

      // Signed out outside the app: the next window connect re-reads gh and stops the sweep.
      rmSync(join(appData, "tools", "gh", "signed-in"));
      const stop = vi.spyOn(sweep as SweepService, "stop");
      const refresh = vi.spyOn(service, "refresh");
      const reloaded: Message[] = [];
      service.connect((message) => reloaded.push(message));
      expect(refresh).toHaveBeenCalledOnce();
      await refresh.mock.results[0]?.value;
      expect(stop).toHaveBeenCalledOnce();
      expect(reloaded.at(-1)).toMatchObject({
        type: "setup.state",
        payload: {
          watchReady: false,
          disabledReason: expect.stringContaining("gh is not signed in"),
        },
      });
    } finally {
      await service.stop();
      db.close();
    }
  },
);

it("reports the GitLab areas disabled while glab is missing, without blocking Watch", async () => {
  const exec: Exec = {
    runText: async (cmd) =>
      cmd === "gh"
        ? { ok: true, data: GH_STATUS_OK, exitCode: 0 }
        : { ok: false, error: "absent", code: null },
    runJSON: async () => ({ ok: false, error: "unused", code: null }),
  };
  const tools = {
    readiness: async (tool: string) =>
      tool === "gh"
        ? { state: "ready" as const, version: "2.74.0" }
        : { state: "missing" as const },
    install: async () => {},
  };
  const { service, states, progress } = setup({ exec, tools: async () => tools });
  await service.refresh();

  expect(row(states().at(-1), "glab")).toMatchObject({
    state: "missing",
    action: "install",
    reason: expect.stringContaining(GITLAB_AREAS_REASON),
  });
  expect(GITLAB_AREAS_REASON).toContain("upstream, radar");
  expect(states().at(-1)?.watchReady).toBe(true);
  expect(service.doctor()).toEqual({
    state: "partial",
    problems: [expect.stringContaining(GITLAB_AREAS_REASON)],
  });

  await service.routes["setup.signin"]?.(request("setup.signin", { tool: "glab" }), () => {});
  expect(progress()).toEqual<SetupSigninProgress[]>([
    {
      requestId: "req-setup.signin",
      tool: "glab",
      state: "failed",
      reason: "Paste a GitLab token to sign in glab.",
    },
  ]);
});

it.each(["git", "gh"] as const)("keeps Watch ready when %s needs an update", async (tool) => {
  const exec = fakeExec((cmd, args) => {
    if (cmd === "gh" && args[1] === "status") return GH_STATUS_OK;
    if (cmd === "gh" && args[1] === "token") return "gho_fixture";
    return undefined;
  });
  const start = vi.fn(async () => true);
  const createSweep = vi.fn(() => ({ start, stop: async () => {} }));
  const { service, states } = setup({
    exec,
    git: async () => ({
      ...git,
      readiness: async () => ({
        state: tool === "git" ? "needs-update" : "ready",
        version: "2.45.0",
      }),
    }),
    tools: async () => ({
      ...managedGh,
      readiness: async (name) =>
        name === "gh"
          ? { state: tool === "gh" ? "needs-update" : "ready", version: "2.74.0" }
          : { state: "missing" },
    }),
    createSweep,
  });
  await service.refresh();
  expect(row(states().at(-1), tool)).toMatchObject({ state: "needs-update", action: "install" });
  expect(states().at(-1)).toMatchObject({ watchReady: true, disabledReason: null });
  expect(createSweep).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledOnce();
});

it("sends setup.state to each fresh connection", async () => {
  const exec = fakeExec((_cmd, args) => (args[0] === "--version" ? undefined : GH_STATUS_OK));
  const tools = {
    readiness: async () => ({ state: "missing" as const }),
    install: async () => {},
  };
  const { service, states } = setup({ exec, tools: async () => tools });
  await vi.waitFor(() => expect(states()).toHaveLength(1));
  expect(states()[0]).toMatchObject({ watchReady: false });

  const reloaded: Message[] = [];
  service.connect((message) => reloaded.push(message));
  expect(reloaded.map(({ type }) => type)).toEqual(["setup.state"]);
  expect(reloaded[0]?.payload).toEqual(states()[0]);
});

it.skipIf(process.platform === "win32")(
  "uses a signed-in gh from the login-shell PATH when no managed copy exists",
  async () => {
    const shell = join(directory, "shell", "bin");
    mkdirSync(shell, { recursive: true });
    writeFileSync(join(shell, "gh"), GH_FIXTURE);
    chmodSync(join(shell, "gh"), 0o755);
    writeFileSync(join(directory, "signed-in"), "");
    const tools = installer();
    const created = vi.fn();
    const { service, states } = setup({
      exec: hostExec(tools, `${shell}:/usr/bin:/bin`),
      tools: async () => tools,
      createSweep: () => {
        created();
        return { start: async () => true, stop: async () => {} };
      },
    });
    await service.refresh();

    expect(await tools.readiness("gh")).toEqual({ state: "missing" });
    expect(row(states().at(-1), "gh")).toMatchObject({
      state: "ready",
      action: null,
      scopes: ["repo", "workflow"],
      reason: "Using gh from the login-shell PATH.",
    });
    expect(states().at(-1)).toMatchObject({ watchReady: true, disabledReason: null });
    expect(created).toHaveBeenCalledOnce();
  },
);

it("re-reads on its interval, stops the sweep after an outside sign-out, and re-probes the seat on an account switch", async () => {
  let signedIn = true;
  let token = "gho_first";
  const exec = fakeExec((cmd, args) => {
    if (cmd === "gh" && args[1] === "status") return signedIn ? GH_STATUS_OK : undefined;
    if (cmd === "gh" && args[1] === "token") return signedIn ? token : undefined;
    return undefined;
  });
  const stop = vi.fn(async () => {});
  const probeSeat = vi.fn(async () => ({ kind: "seat-ok" as const, models: ["auto"] }));
  const { states } = setup({
    exec,
    tools: async () => managedGh,
    probeSeat,
    intervalMs: 20,
    createSweep: () => ({ start: async () => true, stop }),
  });
  await vi.waitFor(() => expect(states().at(-1)?.watchReady).toBe(true));
  expect(probeSeat).toHaveBeenCalledOnce();

  token = "gho_second";
  await vi.waitFor(() => expect(probeSeat).toHaveBeenCalledTimes(2));

  signedIn = false;
  await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  expect(states().at(-1)).toMatchObject({ watchReady: false });
});

it("starts a sweep again at the next ready read after its start rejected", async () => {
  let signedIn = false;
  const errors: unknown[] = [];
  const start = vi
    .fn<() => Promise<boolean>>()
    .mockRejectedValueOnce(new Error("prune failed"))
    .mockResolvedValue(true);
  const createSweep = vi.fn(() => ({ start, stop: async () => {} }));
  const { service, states } = setup({
    exec: fakeExec((cmd) => (cmd === "gh" && signedIn ? GH_STATUS_OK : undefined)),
    tools: async () => managedGh,
    createSweep,
    onError: (error) => errors.push(error),
  });
  await vi.waitFor(() => expect(states()).toHaveLength(1));
  signedIn = true;
  await service.refresh();
  await vi.waitFor(() => expect(errors).toHaveLength(1));
  expect(start).toHaveBeenCalledOnce();

  await service.refresh();
  expect(createSweep).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledTimes(2);
  await service.refresh();
  expect(start).toHaveBeenCalledTimes(2);
});

it("runs one gh sign-in flow when copilot and gh ask together", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const logins = vi.fn();
  const exec: Exec = {
    runText: async (cmd, args) => {
      if (cmd === "gh" && args[1] === "login") {
        logins();
        await held;
        return { ok: true, data: "", exitCode: 0 };
      }
      return { ok: false, error: "absent", code: null };
    },
    runJSON: async () => ({ ok: false, error: "unused", code: null }),
  };
  const { service } = setup({ exec, tools: async () => managedGh });
  const copilot = service.routes["setup.signin"]?.(
    request("setup.signin", { tool: "copilot" }),
    () => {},
  );
  const gh = service.routes["setup.signin"]?.(request("setup.signin", { tool: "gh" }), () => {});
  await gh;
  release();
  await copilot;
  expect(logins).toHaveBeenCalledOnce();
});

type Held = {
  cmd: string;
  args: string[];
  opts: Parameters<Exec["runText"]>[2];
  release: (data?: string) => void;
};

/** An Exec whose sign-in calls wait until the test releases them; other calls answer at once. */
function heldExec(answer: (cmd: string, args: string[]) => string | undefined = () => undefined) {
  const held: Held[] = [];
  const exec: Exec = {
    runText: async (cmd, args, opts) => {
      const signin =
        (cmd === "gh" && args[1] === "login") ||
        (cmd === "glab" && args[0] === "api" && !!opts?.env?.GITLAB_TOKEN) ||
        (cmd === "glab" && args[1] === "login");
      if (!signin) {
        const data = answer(cmd, args);
        return data === undefined
          ? { ok: false, error: "absent", code: null }
          : { ok: true, data, exitCode: 0 };
      }
      // Ignores the abort signal, the worst case: the old flow runs to its end.
      return new Promise((resolve) => {
        held.push({
          cmd,
          args,
          opts,
          release: (data) =>
            resolve(
              data === undefined
                ? { ok: false, error: "absent", code: null }
                : { ok: true, data, exitCode: 0 },
            ),
        });
      });
    },
    runJSON: async () => ({ ok: false, error: "unused", code: null }),
  };
  return { exec, held };
}

/** Releases every held call, including ones made later, until the flow settles. */
async function drain(flow: unknown, held: Held[], data?: string) {
  let done = false;
  void Promise.resolve(flow).then(() => {
    done = true;
  });
  await vi.waitFor(() => {
    for (const call of held) call.release(data);
    expect(done).toBe(true);
  });
}

function signinRequest(id: string, payload: { tool: string; token?: string }) {
  return { ...request("setup.signin", payload), id };
}

function cancelRequest(requestId: string): Message {
  return {
    version: PROTOCOL_VERSION,
    id: `cancel-${requestId}`,
    kind: "request",
    type: "setup.signin.cancel",
    payload: { requestId },
  };
}

function killFixtureProcess(pid: number): void {
  if (pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

const DEVICE_OUTPUT =
  "! First copy your one-time code: WXYZ-9876\nOpen this URL to continue in your web browser: https://github.com/login/device\n";
const PAT_SELF = JSON.stringify({ scopes: ["api"] });

function progressOf(messages: Message[]) {
  return messages.flatMap((message) =>
    message.type === "setup.signin.progress" ? [message.payload] : [],
  );
}

it.each(["gh", "copilot"])(
  "cancels only the requested %s flow and ignores unknown, rejected and stale requests",
  async (tool) => {
    const { exec, held } = heldExec((cmd, args) =>
      cmd === "glab" && args[0] === "api" ? PAT_SELF : undefined,
    );
    const { service, progress } = setup({ exec, tools: async () => managedGh });
    const route = service.routes["setup.signin"];
    const cancel = service.routes["setup.signin.cancel"];
    expect(cancel).toBeTypeOf("function");
    const first = route?.(signinRequest("req-first", { tool }), () => {});
    const other = route?.(
      signinRequest("req-glab", { tool: "glab", token: "glpat-OtherFlow0123456789" }),
      () => {},
    );
    await vi.waitFor(() => expect(held).toHaveLength(2));
    await route?.(
      signinRequest("req-rejected", { tool: tool === "gh" ? "copilot" : "gh" }),
      () => {},
    );
    const before = [...progress()];
    await cancel?.(cancelRequest("req-unknown"), () => {});
    await cancel?.(cancelRequest("req-rejected"), () => {});
    await cancel?.(cancelRequest("req-glab"), () => {});
    expect(progress()).toEqual(before);
    expect(held.every((call) => !call.opts?.signal?.aborted)).toBe(true);

    await cancel?.(cancelRequest("req-first"), () => {});
    await cancel?.(cancelRequest("req-first"), () => {});
    expect(held[0]?.opts?.signal?.aborted).toBe(true);
    expect(held[1]?.opts?.signal?.aborted).toBe(false);
    held[0]?.opts?.onOutput?.("stderr", DEVICE_OUTPUT);
    held[0]?.release();
    await first;
    expect(progress().filter(({ requestId }) => requestId === "req-first")).toEqual([
      { requestId: "req-first", tool, state: "starting" },
      { requestId: "req-first", tool, state: "failed", reason: "Sign-in was cancelled." },
    ]);
    expect(progress().filter(({ requestId }) => requestId === "req-glab")).toEqual([
      { requestId: "req-glab", tool: "glab", state: "starting" },
      { requestId: "req-glab", tool: "glab", state: "waiting" },
    ]);

    const fresh = route?.(signinRequest("req-fresh", { tool }), () => {});
    await vi.waitFor(() => expect(held).toHaveLength(3));
    const after = [...progress()];
    await cancel?.(cancelRequest("req-first"), () => {});
    expect(held[2]?.opts?.signal?.aborted).toBe(false);
    expect(progress()).toEqual(after);
    held[2]?.release("");
    await fresh;
    const finished = [...progress()];
    await cancel?.(cancelRequest("req-fresh"), () => {});
    expect(held[2]?.opts?.signal?.aborted).toBe(false);
    expect(progress()).toEqual(finished);
    await drain(other, held, PAT_SELF);
    expect(progress().at(-1)).toEqual({
      requestId: "req-glab",
      tool: "glab",
      state: "completed",
    });
  },
);

it.each(["gh", "copilot"])(
  "reports completed when %s exits successfully before cancellation but before terminal progress",
  async (tool) => {
    const { exec, held } = heldExec();
    const { service, progress } = setup({ exec, tools: async () => managedGh });
    const flow = service.routes["setup.signin"]?.(signinRequest("req-exited", { tool }), () => {});
    await vi.waitFor(() => expect(held).toHaveLength(1));
    held[0]?.release("");
    expect(progress()).toEqual([{ requestId: "req-exited", tool, state: "starting" }]);
    await service.routes["setup.signin.cancel"]?.(cancelRequest("req-exited"), () => {});
    expect(held[0]?.opts?.signal?.aborted).toBe(true);
    await flow;
    expect(progress()).toEqual([
      { requestId: "req-exited", tool, state: "starting" },
      { requestId: "req-exited", tool, state: "completed" },
    ]);
  },
);

it("ignores cancellation once terminal progress is published, before the flow unwinds", async () => {
  const { exec, held } = heldExec();
  const { service } = setup({ exec, tools: async () => managedGh });
  service.connect((message) => {
    if (message.type === "setup.signin.progress" && message.payload.state === "completed") {
      void service.routes["setup.signin.cancel"]?.(cancelRequest("req-gh"), () => {});
    }
  });
  const flow = service.routes["setup.signin"]?.(signinRequest("req-gh", { tool: "gh" }), () => {});
  await vi.waitFor(() => expect(held).toHaveLength(1));
  held[0]?.release("");
  await flow;
  expect(held[0]?.opts?.signal?.aborted).toBe(false);
});

it.skipIf(process.platform === "win32").each(["gh", "copilot"])(
  "reports completed when fixture gh exits zero with updated credentials and open pipes before %s is cancelled",
  async (tool) => {
    const bin = join(directory, "exited-bin");
    const pidFile = join(directory, "exited-pid");
    const grandchildPidFile = join(directory, "exited-grandchild-pid");
    const credentials = join(directory, "exited-hosts.yml");
    mkdirSync(bin);
    writeFileSync(credentials, "stored-fixture-credential\n");
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh
case "$1 $2" in
  "auth login")
    echo $$ > "${pidFile}"
    printf 'replacement-fixture-credential\\n' > "${credentials}"
    sleep 30 &
    echo $! > "${grandchildPidFile}"
    exit 0;;
  *) exit 1;;
esac
`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    const logs: HostExecLog[] = [];
    const exec = new HostExec({
      appData,
      capturedPath: `${bin}:/usr/bin:/bin`,
      installer: { binDir: async () => undefined },
      env: { HOME: directory, PATH: "/usr/bin:/bin" },
      log: (entry) => logs.push(entry),
    });
    const { service, progress } = setup({ exec, tools: async () => managedGh });
    const flow = service.routes["setup.signin"]?.(
      signinRequest("req-exited-pipes", { tool }),
      () => {},
    );
    let grandchildPid = 0;
    try {
      await vi.waitFor(
        () => {
          const pid = Number(readFileSync(pidFile, "utf8"));
          grandchildPid = Number(readFileSync(grandchildPidFile, "utf8"));
          expect(pid).toBeGreaterThan(0);
          expect(grandchildPid).toBeGreaterThan(0);
          expect(() => process.kill(pid, 0)).toThrow();
          expect(() => process.kill(grandchildPid, 0)).not.toThrow();
        },
        { timeout: 5000 },
      );
      expect(progress()).toEqual([{ requestId: "req-exited-pipes", tool, state: "starting" }]);
      await service.routes["setup.signin.cancel"]?.(cancelRequest("req-exited-pipes"), () => {});
      await flow;
      expect(logs.find(({ args }) => args[1] === "login")).toMatchObject({
        exit: 0,
        error: "Command aborted.",
      });
      expect(progress()).toEqual([
        { requestId: "req-exited-pipes", tool, state: "starting" },
        { requestId: "req-exited-pipes", tool, state: "completed" },
      ]);
      expect(readFileSync(credentials, "utf8")).toBe("replacement-fixture-credential\n");
    } finally {
      service.connect(() => {});
      killFixtureProcess(grandchildPid);
      await flow;
    }
  },
  25_000,
);

it.skipIf(process.platform === "win32").each(["gh", "copilot"])(
  "kills the fixture gh child and grandchild when %s is cancelled without changing stored credentials",
  async (tool) => {
    const bin = join(directory, "cancel-bin");
    const pidFile = join(directory, "login-pid");
    const grandchildPidFile = join(directory, "login-grandchild-pid");
    const config = join(directory, "gh-config");
    const credentials = join(config, "hosts.yml");
    mkdirSync(bin);
    mkdirSync(config);
    writeFileSync(credentials, "stored-fixture-credential\n");
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh
case "$1 $2" in
  "auth login")
    echo $$ > "${pidFile}"
    sleep 300 &
    echo $! > "${grandchildPidFile}"
    printf '${DEVICE_OUTPUT}' >&2
    while [ ! -f "${config}/finish" ]; do sleep 1; done
    printf 'replacement-fixture-credential\\n' > "${credentials}";;
  "auth logout") : > "${credentials}";;
  *) exit 1;;
esac
`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    const logs: { args: string[] }[] = [];
    const exec = new HostExec({
      appData,
      capturedPath: `${bin}:/usr/bin:/bin`,
      installer: { binDir: async () => undefined },
      env: { HOME: directory, PATH: "/usr/bin:/bin", GH_CONFIG_DIR: config },
      log: (entry) => logs.push(entry),
    });
    const { service, progress } = setup({ exec, tools: async () => managedGh });
    expect(service.routes["setup.signin.cancel"]).toBeTypeOf("function");
    const flow = service.routes["setup.signin"]?.(signinRequest("req-cancel", { tool }), () => {});
    let pid = 0;
    let grandchildPid = 0;
    try {
      await vi.waitFor(
        () => {
          pid = Number(readFileSync(pidFile, "utf8"));
          grandchildPid = Number(readFileSync(grandchildPidFile, "utf8"));
          expect(pid).toBeGreaterThan(0);
          expect(grandchildPid).toBeGreaterThan(0);
          expect(() => process.kill(grandchildPid, 0)).not.toThrow();
          expect(progress().at(-1)?.state).toBe("waiting");
        },
        { timeout: 5000 },
      );
      await service.routes["setup.signin.cancel"]?.(cancelRequest("req-cancel"), () => {});
      await flow;
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
      await vi.waitFor(() => expect(() => process.kill(grandchildPid, 0)).toThrow());
      expect(progress().at(-1)).toEqual({
        requestId: "req-cancel",
        tool,
        state: "failed",
        reason: "Sign-in was cancelled.",
      });
      expect(progress().every(({ requestId }) => requestId === "req-cancel")).toBe(true);
      expect(readFileSync(credentials, "utf8")).toBe("stored-fixture-credential\n");
      expect(logs.some(({ args }) => args.includes("logout"))).toBe(false);
    } finally {
      service.connect(() => {});
      killFixtureProcess(grandchildPid);
      await flow;
    }
  },
  25_000,
);

it("stamps every sign-in progress with the id of the request that started it", async () => {
  const { exec, held } = heldExec();
  const { service, progress } = setup({ exec, tools: async () => managedGh });
  const flow = service.routes["setup.signin"]?.(signinRequest("req-gh", { tool: "gh" }), () => {});
  await vi.waitFor(() => expect(held).toHaveLength(1));
  held[0]?.opts?.onOutput?.("stderr", DEVICE_OUTPUT);
  held[0]?.release("");
  await flow;
  expect(progress()).toEqual([
    { requestId: "req-gh", tool: "gh", state: "starting" },
    {
      requestId: "req-gh",
      tool: "gh",
      state: "device-code",
      deviceCode: "WXYZ-9876",
      url: "https://github.com/login/device",
    },
    { requestId: "req-gh", tool: "gh", state: "waiting" },
    { requestId: "req-gh", tool: "gh", state: "completed" },
  ]);
});

it("retires an in-flight gh flow on reconnect: none of its progress reaches the new connection, and a new request starts fresh", async () => {
  const { exec, held } = heldExec();
  const { service, progress: before } = setup({ exec, tools: async () => managedGh });
  const old = service.routes["setup.signin"]?.(signinRequest("req-old", { tool: "gh" }), () => {});
  await vi.waitFor(() => expect(held).toHaveLength(1));

  const after: Message[] = [];
  service.connect((message) => after.push(message));
  expect(held[0]?.opts?.signal?.aborted).toBe(true);

  const fresh = service.routes["setup.signin"]?.(
    signinRequest("req-new", { tool: "copilot" }),
    () => {},
  );
  await vi.waitFor(() => expect(held).toHaveLength(2));
  // The old flow's late device code, waiting and terminal arrive during the new pending request.
  held[0]?.opts?.onOutput?.("stderr", DEVICE_OUTPUT);
  held[0]?.release("");
  await old;
  expect(progressOf(after)).toEqual([{ requestId: "req-new", tool: "copilot", state: "starting" }]);

  held[1]?.opts?.onOutput?.("stderr", DEVICE_OUTPUT);
  held[1]?.release("");
  await fresh;
  expect(progressOf(after).map(({ requestId, state }) => `${requestId}:${state}`)).toEqual([
    "req-new:starting",
    "req-new:device-code",
    "req-new:waiting",
    "req-new:completed",
  ]);
  expect(before()).toEqual([{ requestId: "req-old", tool: "gh", state: "starting" }]);
});

it.each(["accepts", "rejects"] as const)(
  "retires an in-flight glab flow on reconnect so no terminal reaches the new connection when GitLab %s the token",
  async (end) => {
    const token = "glpat-OldFlow0123456789";
    const { exec, held } = heldExec((cmd, args) =>
      cmd === "glab" && args[0] === "api" ? PAT_SELF : undefined,
    );
    const { service, progress: before } = setup({ exec, tools: async () => managedGh });
    const old = service.routes["setup.signin"]?.(
      signinRequest("req-old", { tool: "glab", token }),
      () => {},
    );
    await vi.waitFor(() => expect(held).toHaveLength(1));
    expect(before().map(({ state }) => state)).toEqual(["starting", "waiting"]);

    const after: Message[] = [];
    service.connect((message) => after.push(message));
    held[0]?.release(end === "accepts" ? PAT_SELF : undefined);
    await drain(old, held, "");
    expect(progressOf(after)).toEqual([]);
    expect(before().map(({ state }) => state)).toEqual(["starting", "waiting"]);
  },
);

it("answers a second request for a running flow on the same connection instead of dropping it", async () => {
  const { exec, held } = heldExec();
  const { service, progress } = setup({ exec, tools: async () => managedGh });
  const first = service.routes["setup.signin"]?.(signinRequest("req-gh", { tool: "gh" }), () => {});
  await vi.waitFor(() => expect(held).toHaveLength(1));
  await service.routes["setup.signin"]?.(
    signinRequest("req-copilot", { tool: "copilot" }),
    () => {},
  );
  expect(progress()).toContainEqual({
    requestId: "req-copilot",
    tool: "copilot",
    state: "failed",
    reason: "A gh sign-in is already running.",
  });
  held[0]?.release("");
  await first;
  expect(held).toHaveLength(1);
});

it("keeps a planted glab token out of every message, on both connections, and every error", async () => {
  const token = "glpat-Planted0123456789abcdef";
  const errors: unknown[] = [];
  const logs = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    vi.spyOn(console, method),
  );
  const cases = [
    { probe: undefined, reconnect: false, last: "failed" },
    { probe: JSON.stringify({ scopes: ["read_user"] }), reconnect: false, last: "failed" },
    { probe: PAT_SELF, reconnect: false, last: "completed" },
    { probe: PAT_SELF, reconnect: true, last: "waiting" },
  ];
  for (const [index, { probe, reconnect, last }] of cases.entries()) {
    const { exec, held } = heldExec((cmd, args) =>
      cmd === "glab" && args[0] === "api" ? PAT_SELF : undefined,
    );
    const { service, sent, progress } = setup({
      exec,
      tools: async () => managedGh,
      onError: (error) => errors.push(error),
    });
    const later: Message[] = [];
    const flow = service.routes["setup.signin"]?.(
      signinRequest(`req-${index}`, { tool: "glab", token }),
      () => {},
    );
    await vi.waitFor(() => expect(held).toHaveLength(1));
    if (reconnect) service.connect((message) => later.push(message));
    held[0]?.release(probe);
    await drain(flow, held, "");
    expect(progress().at(-1)?.state).toBe(last);
    const scanned = JSON.stringify([sent, later]);
    expect(scanned).not.toContain(token);
    expect(scanned).not.toContain("Planted");
  }
  expect(JSON.stringify(errors.map(String))).not.toContain(token);
  for (const log of logs) expect(JSON.stringify(log.mock.calls)).not.toContain(token);
});
