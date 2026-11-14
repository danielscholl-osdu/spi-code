# Rules for every agent in spi-code

Builders, reviewers and orchestrators all follow these. A brief can add to them; it cannot relax them.

## Where you work

- The main checkout is the first entry of `git worktree list`. Never edit, commit or `git checkout` there.
- A builder works only in its own worktree, on `bead/<id>`. If you were not given one, stop and say so; do not rename or reset a branch someone else is on.
- A reviewer changes nothing in the bead's worktree. Mutations and probes go in your own copy, in your harness's scratch directory or `/tmp`: `git -C <worktree> worktree add --detach <dir>/<you>-<id> HEAD`, removed when you finish. Enter it by its physical path (`cd "$(cd <dir>/<you>-<id> && pwd -P)"`) before installing or building: on macOS `/tmp` is a link to `/private/tmp`, and TypeScript treats the two spellings as different files.
- Before removing any worktree, run `git status --ignored` in it. `node_modules/`, `dist/`, `build/`, `.turbo/` and `*.tsbuildinfo` are rebuilt and safe to lose. Anything else ignored, such as `fixtures/exec/local/`, is data: move it out first. Never use `git worktree remove --force` without that check.

## Secrets and remotes

- Never run `gh` or `glab` with an auth subcommand (`auth token`, `auth status`, `auth login`, `api user`), even with a fake config directory: `gh` reads real tokens from the keychain and prints them. Test sign-in behaviour only with fixture `gh` and `glab` scripts on a test `PATH`. Reading runs (`gh run list`, `gh run view`) is fine.
- If a real credential appears in your output, stop, do not repeat it, and say so first in your reply.
- Push only your own `bead/<id>` branch. Never push `main`, never add or change a remote. Only `scripts/land` moves `main`.
- The repository is public. Private repository names may appear; credentials, email addresses and the contents of private repositories may not.

## Commits

- `git commit -m "$(aipr commit -s)" --trailer "Bead: <id>"`. If `aipr` fails, write a conventional-commit message yourself and keep the trailer.
- No AI attribution: no `Co-authored-by` naming an agent, no "Generated with" line. `scripts/land` refuses both. Before you stop: `git log main..HEAD --format=%B | grep -i co-authored-by` prints nothing.
- New source files start with the MIT header in `AGENTS.md`. No comments that narrate the change.

## Checks and load

Several agents share this machine. The full `scripts/check` runs every test twice and belongs to CI, which `scripts/land` waits on.

- Run `scripts/check --quick`. It takes one to six minutes depending on how much depends on what you changed; give it a ten-minute timeout. A builder pushes its branch and lets CI run the rest, and puts the run id in a bead note. A reviewer pushes nothing.
- CI is one workflow, named Packaged smoke. Its `check` jobs run the full `scripts/check` and its `package` jobs build and smoke the app, each on macOS and Windows.
- To see which test files are slow, read a run's timings instead of running the suite: the check job's summary lists the ten slowest, and `gh run download <run id> -R <owner>/<repo> -n timings-macos-latest-<head sha>` (or `windows-latest`) gives every file's seconds in both passes.
- To run one test file: from the repository root, `pnpm vitest run <path>`. Tests in one package run another package's built output, so after changing a package run `pnpm --filter <package> build` (or `pnpm build`) first.
- A builder runs `pnpm package:mac` only when the diff changes what the packaged smoke looks at: `apps/desktop/src/smoke*`, `scripts/package*.mjs`, `scripts/packaged-host.mjs`, or a selector the smoke reads. A reviewer never does; CI packages and smokes every pushed branch on macOS and Windows.
- A test outside your diff that fails on a 30-second timeout is load. Rerun that file alone and report both results. Never rerun everything for it, and never run a load generator to reproduce one.
- Never end your turn while a command you need is still running: your task ends with no result. Run long commands in the foreground, or in the background only when your harness lets you wait on them.

## Scope

- Build or review exactly the bead's description and acceptance. Something else you notice is a follow-up; see "Follow-ups" in `.agents/skills/bead-review/SKILL.md` for when it earns its own bead.
- When code cannot prove something (an order, a read, a membership), it reports the quieter, honest state: not read, unknown, holds nothing. It never reports a claim. Test that case.
- Don't edit a package's `index.ts`, `package.json`, root config, `vitest.config.ts` or `pnpm-lock.yaml` unless your bead owns that package. Don't add a dependency unless the bead cannot be done without it.
- If the same kind of finding survives two fix rounds, stop and tell the orchestrator. The approach is wrong, not the patch.

## What to test

A test is code the next redesign has to rewrite. Write the ones that guard behaviour and leave the rest out.

- Test behaviour that can break: the model and briefing, projections, parsing of forge and tool output, stores and state machines, credentials, tiers and durability, and the logic a bug fix changed.
- Leave out tests for what the types already guarantee, copy text, static markup, class names, layout, spacing and callback wiring. The packaged smoke's capture is the proof of how a place looks and reads.
- Extend before you add. When an existing test or table covers the behaviour, add a row there.
- Test at one layer, the lowest one that fails without the change. A rule proven in core is not proven again in the host and the window.
- A rule that holds across the whole window stays one test over every fixture: the text rules, the upstream boundary, reachability. Add the case there, not a copy beside each view.

## This machine

- The shell is zsh. A word starting with `=` is expanded as a command path, so quote it (`echo "====="`).
- A fresh worktree has no `node_modules` and no built packages: `pnpm install --frozen-lockfile && pnpm build` before anything else.
- Node 22.22.0 and Bun 1.3.13, ahead of Homebrew's:
  `export PATH="$HOME/.local/share/fnm/node-versions/v22.22.0/installation/bin:$HOME/.bun/bin:$PATH"`
- After main moves under you, run `pnpm install --frozen-lockfile` before checking.
- Fixture regeneration: `pnpm build && TZ=UTC node scripts/watch-snapshot.mjs && pnpm biome check --write`. Commit only `fixtures/watch/snapshot-1106.json` and `inspect-1106.json`; the other snapshots are git-ignored in `fixtures/watch/generated`, which `scripts/check` and packaging regenerate with `node scripts/watch-generated.mjs`. Run that after `pnpm build` before a single test file that reads them.
