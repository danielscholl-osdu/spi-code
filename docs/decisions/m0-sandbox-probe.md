# M0 sandbox probe

**Observed:** Seatbelt runs a local JDK on macOS while denying the tested
credential reads and writes outside the checkout. This is the M0 CT-07/CT-09
spike, not the complete M5 command sandbox.

## Reproduce

From the bead worktree, run:

```sh
pnpm exec vitest run --project packages/host packages/host/src/sandbox/seatbelt.test.ts
pnpm run typecheck
node packages/host/dist/sandbox/probe.js
```

The macOS integration test is skipped on other platforms. The runner uses a
temporary checkout and separate scratch HOME, removes them even on failure,
and reports booleans rather than credential contents. Real paths are only
opened and closed through shell redirection; nothing reads their bytes.
Controlled, public fixture files prove all five deny rules against files that
are readable before confinement, including inside an otherwise readable tree.
An absent real path also reports `readable: false`; that alone is not denial
evidence.

## Observed evidence

Run on 2026-11-04, macOS 27.2 (26B123), arm64, Node 22.22.0.
`/usr/libexec/java_home` located Homebrew OpenJDK at
`/opt/homebrew/Cellar/openjdk@17/17.0.21.0.3/libexec/openjdk.jdk/Contents/Home`.
The actual `bin/java -version` ran through `/usr/bin/sandbox-exec`, exit 0:

```text
openjdk version "17.0.21.0.3" 2026-10-24
OpenJDK Runtime Environment Homebrew (build 17.0.21.0.3+0)
OpenJDK 64-Bit Server VM Homebrew (build 17.0.21.0.3+0, mixed mode, sharing)
```

| Probe | Result |
|---|---|
| Login keychain, `.ssh`, `.kube`, `.azure`, gh config | Each `readable: false` |
| Public file in each credential-shaped fixture directory | Each `readableBefore: true`, `readable: false` |
| Credential directory symlink into allowed checkout, and direct target | Each `readableBefore: true`, `readable: false` |
| Pre-existing credential hard link into checkout | Launch refused before the command ran |
| Missing gh child under symlinked config ancestor, created after profile generation | Both lexical and target reads denied |
| Host listening on fixture Unix socket in temporary root | `connectedBefore: true`, `connected: false` |
| Write outside temporary checkout and scratch HOME | Failed |
| Write inside temporary checkout | Succeeded |
| Child environment names | `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`, `HOME`, `LANG`, `PATH`, `TMPDIR`, `XDG_CONFIG_HOME` |
| Windows restricted token | **Pending: no Windows runner exists yet** |

The environment is constructed from an allow-list, not copied and scrubbed.
`GH_TOKEN`, `GITHUB_TOKEN`, `AZURE_*`, `ARM_*`, `SSH_AUTH_SOCK`, injected
`NODE_OPTIONS`, git configuration environment overrides and the caller's PATH
are not inherited. `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`
disable Git's system and global config loading; they do not forbid helper execution.
HOME, temporary storage and XDG config point into scratch storage.
Empty gh/XDG config overrides are treated as unset, and relative overrides
are resolved from the host's working directory.
When no local JDK exists, the runner downloads a Temurin 17 archive using
Adoptium metadata and verifies its SHA-256 before extraction into scratch.
That fallback was not exercised on this machine.

The profile defaults to deny, with system/JDK reads, checkout/scratch writes,
explicit credential subtree denies covering both lexical and canonical paths.
Missing paths are canonicalized through their nearest existing ancestor before
appending the missing suffix. A metadata-only preflight walks protected paths,
refusing launch for regular files with multiple hard links. The walk is bounded
to depth 16 and 100,000 paths; exceeding either limit or a filesystem error also
refuses launch. No credential bytes are read.
The observed protected directories contain about 75,500 entries, mostly caches;
the scan limit accommodates that without making traversal unbounded.
IP networking remains allowed, including loopback: local servers are reachable.
Unix socket connections are denied except
the system mDNSResponder socket for DNS. The host fixture listener verifies
connection denial independently of file-read rules. macOS 27.2 dyld
aborted without a read grant for the root directory **itself**; `(literal "/")`
resolved this without granting its descendants. Sandbox startup errors throw;
there is no unsandboxed retry. This does not prove CT-08 git-folder isolation,
CT-10 command refusal, credential-helper execution refusal, keychain service API
isolation, or the packaged host on either platform. Those remain M5 work.
Retargeting a symlink during execution is also a known M5 gap: canonical deny
paths are computed before launch, not refreshed while the command runs.

## SDK sandboxConfig

Read-only references: Keelson `packages/providers/src/copilot/sandbox.ts` and
installed `@github/copilot-sdk` 1.0.26 `dist/types.d.ts`,
`dist/generated/rpc.d.ts`, and `dist/client.js`.
The SDK exposes filesystem read/write, read-only and denied paths, networking,
Seatbelt keychain access, bypass and developer-tool access controls. It can
confine runtime-launched MCP/LSP servers as well as built-in commands.
It adds no confinement to commands spawned directly by this host runner.
With no built-in tools exposed, its potential value is defense in depth, not
a replacement for host Seatbelt. Its runtime behavior was not probed here.

Unlike the reference helper's comment about an older fixed field list, this
installed SDK forwards `sandboxConfig` on both create and resume. The typings
say it is applied before session tools/MCP start, requires runtime support,
rejects policy conflicts and must be re-supplied on cold resume. Adoption remains
an M0 decision to revisit at M5; do not claim it is operational from typings alone.

Windows follow-up **spicode-c3t.17**, under M0 and blocked by
**spicode-c3t.12**, must record an observed supported/unsupported restricted-token
result. No Windows confinement or packaged support is claimed by this probe.
