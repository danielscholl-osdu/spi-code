# Confined git add and commit

`PrivilegedGit.add` and `PrivilegedGit.commit` run only through
`runConfined` (`packages/host/src/scopes/confined.ts`), which starts Git
under `@microsoft/mxc-sdk` 1.1.0 with Seatbelt on macOS. Status, diff, fetch
and push stay on the unconfined runner.

## Live macOS check

macOS 27.2 arm64, Homebrew git 2.56.0, Node 22.22.0, from the repository's
pnpm install (build scripts skipped). `node scripts/confined-git-probe.mjs`
after `pnpm --filter @spi-code/host build` makes a managed clone and a linked
worktree, plants a nested repository whose `core.fsmonitor` tries each write
below, then runs `commit(target, "Confined commit", identity, { all: true })`:

```text
platform: darwin arm64, git version 2.56.0
commit result: {"ok":true,"afterExit":"not-known"}
HEAD: 9f103a85bac5 -> 0f5e4f102572
committed: Confined commit

answer.txt
sub
canary log (written from inside the sandbox):
  ran as fsmonitor 2
  operator home: blocked
  temp root: blocked
  clone .git/config: blocked
  worktree .git pointer: blocked
  clone checkout: blocked
  clone .git/hooks: blocked
  network: blocked
host check: home marker absent | clone config unchanged
```

The canary ran (its log is inside the worktree, which is writable), every
write outside the worktree, the clone's `.git` and the run's temp directory
failed, and the commit advanced HEAD.

## What MXC does that the code relies on

- The `command` string is parsed by a shell. The runner wraps its own script
  in `/bin/sh -c` and quotes every argument with `quoteShell`.
- Without `environment`, the child's HOME and working directory are the first
  writable path. The runner always passes the cleaned Git environment with
  HOME set to its read-only empty directory.
- Reads are denied outside the listed paths and the system directories.
  Homebrew git loads libraries from the Homebrew prefix, not its Cellar
  directory, so `installRoot` grants the prefix read-only, falling back to
  narrower paths when the prefix would hold the home or app data. Apple's
  `/usr/bin/git` passes the same confined tests with no extra grant.
- A read-only path inside a writable one holds: writing, renaming over or
  removing `.git/config` and the worktree's `.git` file fail, and so does
  creating the missing `.git/hooks`.
- `probe()` is Windows-only. Proof is per run instead: the script prints a
  random id, then tries to write a host-owned canary outside the policy and
  exits 97 if it can, before Git starts.
- Whether a program Git started is still running after the commit returns is
  not known; results carry `afterExit: "not-known"`.

## Packaging and runtime

- The SDK declares Node 24 or later. Seatbelt runs under Node 22.22.0 here.
- On macOS the SDK runs Seatbelt in-process through `bin/<arch>/libmxc_ffi.dylib`
  loaded by koffi. With `mxc-exec-mac` moved aside the probe still committed
  confined. With the library moved aside, commit returned
  `refused: "mxc-unavailable"` and HEAD did not move.
- The packaged app keeps that library inside the asar, where it cannot be
  loaded, so add and commit are expected to refuse there until
  spicode-xia.25 unpacks it. Not observed in a packaged build.
- Windows and Linux refuse with `unsupported-platform` until spicode-xia.17.
