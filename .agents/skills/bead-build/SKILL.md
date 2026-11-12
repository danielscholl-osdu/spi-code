---
name: bead-build
description: Build one spi-code bead from claim to a reviewed branch ready to land. Use when given a bead id to implement, when asked to "work", "build" or "take" a bead, or when picking up ready work in this repo.
---

# Build a bead

One bead, one worktree, one branch. You build it, someone from another provider reviews it, and `scripts/land` puts it on `main`.

## 1. Claim

Check before you claim. Stop if:

- the bead's epic (`bd show <id>` shows the parent) lacks the `breakdown:approved` label. A bead labelled `main-broken` is the exception: it has no epic and needs no approval.
- a bead labelled `main-broken` is open and this isn't it.

Pick a worker name once, your model plus four random hex characters (for example `sol-7f3a`), and pass it as `--actor` on every `bd` write. bd treats a repeat claim by the same actor as success, so two agents sharing a name could both claim one bead.

```bash
bd show <id>                      # read the description and acceptance
bd update <id> --claim --actor <worker>
bd update <id> --actor <worker> \
  --set-metadata build.provider=<anthropic|openai|google> \
  --set-metadata build.model=<model id>
```

Stop if the claim fails: someone else holds it.

## 2. Get a worktree

From the main checkout:

```bash
git worktree add .worktrees/<id> -b bead/<id> main
```

If your harness already gave you a worktree (T3 Code, a Keelson lease), start from `main` and rename the branch: `git branch -m bead/<id>`. `scripts/land` finds the bead by that branch name.

Never edit files in the main checkout.

## 3. Build

- Do what the acceptance criteria ask, and nothing more. Something else you notice becomes a new bead: `bd create "<title>" -t task --parent <epic> --deps discovered-from:<id>`.
- Write the test named in the acceptance first when you can.
- Follow `AGENTS.md`: the MIT header on new source files, no comments that narrate the change.
- Commit with `aipr` and the bead trailer:

  ```bash
  git commit -m "$(aipr commit -s)" --trailer "Bead: <id>"
  ```

- For work that runs long, keep the claim alive: `bd heartbeat <id> --actor <worker>`.

## 4. Check

```bash
scripts/check --quick
```

It runs lint, typecheck, license headers and, once, the tests your diff reaches: the ones that import what you changed, every package that depends on a package you changed, and every package when a fixture changed. Don't ask for review while it fails.

Don't run the full `scripts/check` on this machine: it runs every test twice, and several agents share the CPU. Push your branch (`git push origin bead/<id>`); CI runs the full check and the packaged smoke on macOS and Windows. Put the run id in a bead note.

`scripts/check` does not run the packaged smoke. If the bead changes `apps/window`, `apps/desktop`, `scripts/package*.mjs` or `scripts/packaged-host.mjs`, also run `pnpm package:mac` (it packages and runs the smoke) and paste its tail in a bead note before asking for review.

## 5. Review, then land

Follow `.agents/skills/bead-review/SKILL.md` to get a review from a different provider. Fix the findings that hold up, and push back on the ones that don't. When the bead has a recorded pass for the current diff, follow `.agents/skills/bead-land/SKILL.md`.

If you stop before landing, leave a note saying where you got to (`bd note <id> "<state>"`) and keep the claim, so the next agent can pick it up.
