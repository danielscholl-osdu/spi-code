# Rules for every agent in spi-code

Builders, reviewers and orchestrators all follow these. A brief can add to them; it cannot relax them.

## Where you work

- The main checkout is the first entry of `git worktree list`. Never edit, commit or `git checkout` there.
- A builder works only in its own worktree, on `bead/<id>`. If you were not given one, stop and say so; do not rename or reset a branch someone else is on.
- A reviewer changes nothing in the bead's worktree. Mutations and probes go in your own copy: `git -C <worktree> worktree add --detach /tmp/<you>-<id> HEAD`, removed when you finish.
- Before removing any worktree, run `git status --ignored` in it. Ignored data, such as `fixtures/exec/local/`, is lost with it. Never use `git worktree remove --force` without that check.

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

Several agents share this machine. The full `scripts/check` runs every test twice and belongs to CI and `scripts/land`.

- Run `scripts/check --quick`. Push your branch and let CI run the rest; put the run id in a bead note.
- Run `pnpm package:mac` only when your diff changes what the packaged smoke looks at: `apps/desktop/src/smoke*`, `scripts/package*.mjs`, `scripts/packaged-host.mjs`, or a selector the smoke reads. CI packages and smokes every pushed branch on macOS and Windows.
- A test outside your diff that fails on a 30-second timeout is load. Rerun that file alone and report both results. Never rerun everything for it, and never run a load generator to reproduce one.
- Run long commands in the foreground. If you end your turn while one runs in the background, your task ends with no result.

## Scope

- Build or review exactly the bead's description and acceptance. Something else you notice is a follow-up; see "Follow-ups" in `.agents/skills/bead-review/SKILL.md` for when it earns its own bead.
- When code cannot prove something (an order, a read, a membership), it reports the quieter, honest state: not read, unknown, holds nothing. It never reports a claim. Test that case.
- Don't edit a package's `index.ts`, `package.json`, root config, `vitest.config.ts` or `pnpm-lock.yaml` unless your bead owns that package. Don't add a dependency unless the bead cannot be done without it.
- If the same kind of finding survives two fix rounds, stop and tell the orchestrator. The approach is wrong, not the patch.

## This machine

- Node 22.22.0 and Bun 1.3.13, ahead of Homebrew's:
  `export PATH="$HOME/.local/share/fnm/node-versions/v22.22.0/installation/bin:$HOME/.bun/bin:$PATH"`
- After main moves under you, run `pnpm install --frozen-lockfile` before checking.
- Fixture regeneration: `pnpm build && TZ=UTC bun scripts/watch-snapshot.ts && pnpm biome check --write`.
