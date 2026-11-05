---
name: stop-the-line
description: Handle a broken main in spi-code. Use when scripts/check fails on main, CI on main goes red, a landed bead caused a regression, or a bead labelled main-broken exists.
---

# Stop the line

A broken `main` comes before every other bead. While a bead labelled `main-broken` is open, `scripts/land` refuses everything except its fix.

## 1. Open it

```bash
bd create "main broken: <what fails>" -t bug -p 0 -l main-broken,risk:std \
  -d "<failing command and output; the commit that introduced it, if known>"
```

Find the commit: `git log --oneline` since the last good check, and `git bisect` if it isn't obvious. Note the bead it landed under (the `Bead:` trailer).

## 2. Revert or fix forward

- **Revert** if the cause isn't clear within about 30 minutes, or the fix is bigger than the break. Revert the landed commit on a `bead/<id>` branch for the `main-broken` bead, and reopen the original bead with a note saying why. Clear its old landing and review so its next attempt starts fresh: `bd update <original> --unset-metadata land.sha --unset-metadata review.verdict --unset-metadata review.patch_id`.
- **Fix forward** if the cause is clear and the fix is small.

Either way the change follows `bead-build`, which exempts a `main-broken` bead from epic approval. It is built in a worktree, gets a `risk:std` review from another provider (one round is usually enough), and lands with `scripts/land <main-broken id>`. Landing it closes the bead and opens the line again.

## 3. Learn from it

If the break got past `scripts/check`, add the missing check in the same fix, or file a bead for it. Say in the closing note what let the break through.
