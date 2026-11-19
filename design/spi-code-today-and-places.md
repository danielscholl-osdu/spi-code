# Today and its places: settled design

The mock is `spi-code-today-and-places.html` beside this file. Open it in a browser: the toolbar switches the morning and the theme, and runs five walkthroughs. It is built from the live sweep of Mon 16 Nov 19:06, so every name, number and link in it is real unless the data section below says otherwise. Where the mock and this file differ, this file wins. The design council (Claude Opus 5.5, Codex Sol, Muse Wonder) scored it 9, 9 and 9 in round 7 with no must-fix findings, and the maintainer settled it on 2026-11-17.

The place the council called Engineering system is named Template, as the window names it (maintainer, 2026-11-17, spicode-djg.30).

The rulings read newest first: Z (draft 6 and later) overrides X (the operator's pass), which overrides the older rulings further down. Where an older ruling says "Detail", read it as the opened row on Today or the popover on a place (Z2, Z3).

## Draft 4: the operator's pass

After round 3 settled at 9/9/9, the operator used the mock and rejected how Today reads. Draft 4 is that pass; X11 came after round 5. Its rulings override anything below that disagrees.

| # | Ruling | Operator's words |
|---|---|---|
| X1 | **No verbs on Today.** Core's verb names (Classify entry, Investigate, Re-run lanes, Absorb toolchain) never show. Each line is a short headline: the fork (or "n forks") and what is wrong, in the operator's words. Verbs stay internal to grouping; action words appear only on Detail's buttons. | "I don't even know as a user what those words mean. It's just something that opens up the next panel." |
| X2 | **Lines group by situation, not verb.** Investigate · 2 split into storage (fails Validation Summary) and partition (lane deploy failed). The red-PR, absorb and approve groups stay grouped. | same |
| X3 | **No restated facts.** A line does not repeat its age ("halted for 6d"), its link ("opened a halt issue"), the section's rank (P0/P1 tags gone), or explanations under headings. The page lede is the date only. Can wait, Moving without you and Last 24 hours are counts, not sentences. | "Look at the extra verbiage still that serves no purpose." |
| X4 | **Today is a table.** Columns Fork, What, Open, Age, under a small header. A group's header row holds the shared What; each member is its own sub-row with its fork, its link in the Open column and its own age, so every link and every age sits in one column. | "The text blends." "Why so unaligned?" |
| X5 | **Links are typed pills.** Icon plus kind and number: PR (pull-request icon, teal), Issue (issue icon, blue), MR (GitLab, magenta), Commit and Deployments (grey). | "Hard to pick out things like PR vs Issue." |
| X6 | **A deadline is a clock icon by the age, with the reason on hover.** "Fix before the next upstream sync, Tue 18:00" (core's `due.before` is "next sync"); "Dispatch before Tue 02:00, when the scheduled sync opens all 7 PRs at once". "After lanes drain" is a condition, not a deadline: it is step 1 in that line's Detail, not on Today. Detail shows the deadline in full. | "Not sure where the befores or afters come from." "Why not just put the icon with a hover." |
| X7 | **Sections say what they mean.** Now is **Blocked** (red dot, red-tinted box): something cannot move until you act. Today is **Waiting on you** (amber dot): it needs you, nothing is stuck. Then **Can wait** (grey dot), **Moving without you** (blue dot), **Last 24 hours** (hollow ring, dashed box). All five use the same row grid. | "What is the difference between Now and Today? That blends." |
| X8 | **No Place column.** Rows you act on open Detail, whose breadcrumb leads to the exact cell in the place; the sidebar lists the places. Rows in the lower three sections have no Detail, so the whole row opens its place (› at the end, place name on hover). | "Do we think the links to the place hold any real value?" |
| X9 | **Detail says only what the button doesn't.** Title, deadline, Cause, Effect, Next only when there are two ordered moves, the buttons. Gone: the On Today chip when you came from Today (kept when you came from a place, without P0/P1), the rank and age line, a Next that repeats the button, the small print under buttons, Also on Today, core error codes (UNKNOWN_TOP_LEVEL). Sources become **Also on GitHub** and list only links that are not already buttons. A group's Detail is the cause in one sentence, the steps, the button and one row per member; Failed checks moved to each member's Detail. | "The detail screen tells us extra stuff, not sure we need it there." |
| X10 | **Light theme is firmer.** `border` #d4d4d8, `borderSoft` #e4e4e7, `textMuted` #52525b, `sidebar` #efeff1, `chrome` #f4f4f5. Dark unchanged. These are visual-design tokens; the page `design/spi-code-visual-design.html` takes the same values when this lands. | "On light mode are we too washed out?" |
| X11 | **Detail follows Today's rule: no word that doesn't do work.** The title is the row's headline ("crs-conversion sync halted", "legal PR #90 red: its deploy lane failed"). No field labels: the cause is the first sentence, the effect a muted second one (dropped when it says nothing waits), ordered steps a numbered list. The deadline carries the clock icon ("Before the next upstream sync, Tue 18:00"). One primary button; every other way out is a typed pill under it (Issue #44, Run, PR #50, Commit, MR !968), with no "Also on GitHub" heading. Button labels drop "on GitHub" (↗ already says it leaves). The evidence chip is gone; the Evidence tab carries "⌀ n" when something was not read. A repository line not on Today says "Not on Today. Counted under Can wait." when Can wait counts it, and otherwise "Not on Today." The empty pane says "Select a row." | "Make sure we are adhering to the same rule on the side panel. Be very aware of unnecessary words." |
| X12 | **The action is a pill-sized button in the same row as the link pills**, first, tinted in the accent with a small ▸ so it reads as something SPI Code does, while the outlined ↗ pills read as links out. The opened row no longer repeats the pill already on its own row. Popovers use the same row. | "I don't think you need such a giant button on the row expand. Less intrusive but clear." |

Rulings still standing from drafts 2 and 3 where X1 to X10 don't override them: the grouping rules (whose move decides Today; one member per object; a blocked item's move is its blocker's), the counts (18 members, Line 16, Engineering 1, Upstream 1), Can wait's exclusion, the station and rollout vocabularies, Evidence, and the paths out to GitHub and GitLab. Where an older ruling quotes a verb label or a Now/Today heading, read it through X1 and X7.

## Draft 6: no Detail panel

The operator asked whether the right-hand panel adds any real value. The three seats answered it adversarially and all three ruled **replace**. Their shared inventory: once X9 and X11 removed what the row, the place or one ↗ already shows, the panel carried only four things, each about one row: an action only SPI Code can start (a Copilot thread, a queued re-run, a dispatch, a port), the order of two moves, a cause or scope the sources don't state (which blocker, which seven forks), and what SPI Code did not read. A permanent 380px column, empty by default ("Select a row.") and repeating the table beside it for groups, doesn't earn its width or the click on every row.

| # | Ruling | Source |
|---|---|---|
| Z1 | **No right-hand panel.** The window is sidebar and centre. Today's table and the Line's five stations get the width back. | all three verdicts |
| Z2 | **On Today, a row opens in place.** Clicking a row's fork or headline expands it under the row, across What to Age: the place link (Line › fork › station), the deadline in full, the cause, the effect, the steps when there are two, the one button, and any further pills. A group expands under its header row with the shared cause, the steps and the group button; its members are already the sub-rows, so they are not repeated. A sub-row expands under itself. Clicking again, Esc, or clicking elsewhere closes it. Only one row is open at a time. | Opus, Sol, Muse |
| Z3 | **On a place, a popover opens on what you clicked.** Line cells, rollout forks, environment runs and repository lines open the same content anchored under the clicked element, with a title (the subject is not otherwise on screen) and, from a place, "On Today · …" linking back to the row. It does not repeat what the place shows beside it ("Other stations" is the same sheet row; it is gone). A cell holding a Blocked item leads with that item's action. The Dispatch popover names its seven forks. | Opus, Sol, Muse |
| Z4 | **Evidence is a page, opened from ⌀.** A row or popover whose item has something not read carries "⌀ n" by its age; it opens Evidence for that row, with "‹ Today" (or the place) to go back. The Swept capsule opens Evidence for what is open (a row or a popover), with "Whole sweep ›" on the page; with nothing open, it opens the whole sweep. Not read first, then reads with their times, then areas (ruling J) is unchanged. | Opus, Sol, Muse |
| Z5 | **The way out is unchanged.** A pill opens the source; ⌘↵ opens the open row's or popover's primary source; nothing else leaves the app. | Opus, Sol |
| Z6 | **What it revises.** The five layers become four surfaces: Today (rows that open in place), the place (popovers on its marks), Evidence (a page) and the source. Ruling E ("every Detail has a primary action") holds for every expansion and popover. X8's "Detail's breadcrumb" is now the place link at the top of an expansion. The window layout's Detail panel (`design/spi-code-window-layout.html`) is replaced when this lands. | Sol, Opus |
| Z7 | **No Copilot actions yet.** The operator: "lets drop those things as we don't know yet if we need them. I think we can figure out a better way or different way to work with copilot AI." Removed: "Add a filter rule" (Copilot thread), "Port !968 (Copilot thread)", "Upgrade os-core-common on the fork (Copilot thread)", "Ask Copilot why", "Ask Copilot to triage". A button stays only if its label says what it produces: it opens a source (↗), or it names an SPI Code operation and its scope ("Queue the re-run of all 5 lanes", "Dispatch Sync Template to 7 forks"). A step the operator does by hand is a sentence, with the file or MR it touches as the link ("Add a rule for schemathesis-tests to .github/upstream-filter.yml, then dispatch sync." · Open upstream-filter.yml ↗). How SPI Code works with Copilot is a separate design. That design ([spi-code-threads.md](spi-code-threads.md), 2026-11-19) adds one control, Ask about this, at the end of an opened row's or popover's source pills: it opens a draft thread about that row and sends nothing. The removed buttons stay removed. |

## Round 7 result

Opus 9, Sol 9, Muse 9, no must-fix findings. Round 6 had scored 8.5 from each seat; its must-fix findings (the leftover Detail tabs, ⌀ not following the item, links that didn't reach their place) were fixed before round 7. Round 7's nits are applied: walkthrough 1 matches Z7 and its last step opens a popover's pill; pills name their source ("Sync Upstream run", "Template change"); no opened row restates its headline or its age; manual steps name the file (pom.xml, upstream-filter.yml); group buttons name their fork instead of "(oldest)"; any opened row with a gap ends "⌀ n not read · Evidence ›"; a two-member cell keeps the lead's hand step.

## Round 5 result

Round 5 scored Opus 9, Sol 9, Muse 9, each with no must-fix findings. Their nits are applied: Evidence and walkthrough 5 say SPI Code, not core; a Line cell that holds a Blocked item leads with that item's action ("Add a filter rule for schemathesis-tests"); a stopped cell with no item puts "not read" in Evidence, not a ⌀ in the sentence; "human-required" reads "needs a person"; the disabled "Re-run now" is gone; the Line plan says "workflow (waits for a released os-core-common)"; walkthrough 4 names the deadline and the lanes.

## Round 4 rulings

Round 4 scored Sol 8, Opus 8.5, Muse 8.5. Every must-fix finding was the same kind: draft 4's plain language and lean Detail reached Today but not every place, Detail variant, Evidence label or walkthrough. Draft 5 carries them everywhere.

| # | Ruling | Answers |
|---|---|---|
| Y1 | **Core codes never reach the operator.** The Line cell says "halted: no filter rule for schemathesis-tests" (not UNKNOWN_TOP_LEVEL), "provider changes to port" (not "port owed"). The Evidence area is "Upstream toolchain changes" (not "Toolchain radar"). "On Today here" rows carry no P0/P1. Walkthrough captions say blocked, marked fork, upgrade. | Sol 1, Opus 1, Muse 1 |
| Y2 | **One word for the toolchain move: upgrade.** The member title ("unit: upgrade os-core-common 8.5.0, then review PR #50"), its two steps, its button ("Upgrade os-core-common 8.5.0 on the fork (Copilot thread)"), the Evidence title and walkthrough 1. | Sol 1, Opus 2 |
| Y3 | **Every Detail variant follows X9.** Cells, environment runs, rollout forks and repository lines list only links that are not buttons, under "Also on GitHub", "Also on GitLab" or "Also on GitHub and GitLab" by what the list holds. A merged rollout fork's title carries its stage once. | Sol 2, Muse 2, Opus nit |
| Y4 | **A group's Detail is cause, steps when there are two, button, members.** The approve group's cause is "Each PR is green and waits for your approval"; no Next. Its one rule stays under the button: "Use a merge commit, not a squash." Member rows drop a reason that is the same for every member. | Sol 2, Muse 3, Opus nit |
| Y5 | **A stopped cell says what holds it.** A cell held by a Blocked item says "Held by the blocked sync: crs-conversion sync halted." and offers no "Ask Copilot why". A stopped cell with no item says "Not on Today. SPI Code has no item for this, and ⌀ didn't read the run." | Opus 3 |
| Y6 | **Dispatch Detail drops core's `rollout.more`.** Title, the deadline, Cause, Effect ("14 lanes still to go"), the buttons. No Plan, Watch or Reaches. | Opus 4, Muse nit |
| Y7 | **A Cause that restates the title is not shown** (storage PR #83, crs-conversion's sync PR). | Muse nit |
| Y8 | **Group evidence chips count reads again**, summing the member forks' reads ("18 reads · 9 areas"); Evidence heads them "Reads of the forks in this row". | Opus |
| Y9 | **partition's headline says the rerun:** "lane deploy failed; a rerun is in progress", matching Moving without you. | Opus nit |
| Y10 | **Copy.** The rollout legend says "the 7 forks the template hasn't reached". Evidence says "SPI Code read this item from these areas". Repository column headers have room. | Opus nits |

## Draft 2 rulings, from scoring round 1

Round 1 scored Opus 7, Sol 7.5, Muse 7. Their findings overlapped; each ruling below names the seats it answers.

| # | Ruling | Answers |
|---|---|---|
| A | **One count of what is yours: verb-line members.** 18 everywhere: sidebar Today 18, Now 2 + Today 16. Each place's "n yours on Today" counts the members whose home is that place: Line 16, Template 1, Upstream 1, Environment 0. "5 wait on you" is gone. | Opus 1, Muse 1 |
| B | **One object, one story.** A repository line that is an item's source or the sync engine's companion issue shows "On Today · P0 Classify entry" and opens that item's Detail, with the Engineering breadcrumb. Issue #72 (indexer, "Upstream Sync Failed", opened 34m ago) is now the source of indexer's P0; the copy says the halt issue is open. Unmatched lines keep the generic triage copy. | Opus 2, Sol 4 |
| C | **The effective move projects everywhere.** A Re-run member's Detail, its Main and Lane cells, and every "Also on Today" row name Re-run lanes and lead with the re-run. The merge is step 2. | Opus 3, Sol 3, Muse 2 |
| D | **Absorb, then review.** The four sync PRs that carry an os-core-common move are their own line, "Absorb toolchain, then review · 4". Each member keeps both causes, both sets of sources and the steps in order; the primary action starts the absorb, the PR is the second button. crs-conversion #41 stays in "Review on GitHub". | Sol 2 |
| E | **Every Detail has a primary action.** A cell or rung that holds one member shows that member's Detail, with the cell's or rung's state in the meta line. A cell with no member opens its PR, latest run or upstream project. A to-dispatch rung is the Dispatch Detail. | Opus 5, Muse 3 |
| F | **The sidebar count is the head's count.** Line 7 (forks stopped), Environment ✓, Template 7 (to dispatch), Upstream 1. | Opus 6 |
| G | **Dispatch shows its decision.** Detail renders core's `rollout.more`: Plan (unpaced), Watch (the Tue 02:00 template sync opens all 7 at once), Reaches (java-build action). The member reads "Sync Template to 7 forks · or Tue 02:00 opens all 7 at once". It shows no age: `rollout.age` is null. | Opus 7, Muse data |
| H | **The calm morning is consistent.** Finished work is under Last 24 hours, not Moving without you. The Line shows all 13 forks, no fold, and the plan line says no wave is in flight. Can wait stays. | Opus 8, Sol nit, Muse nit |
| I | **Places mark, they don't list.** The "Yours here" boxes on Environment and Template are gone. The 7 to-dispatch rungs carry the dot. Re-run lanes' home is the Line, where its PRs are (Main and Lane cells). | Muse 4, Sol nit |
| J | **Evidence shows only what core has.** No budget. Each area shows its real `observedAt` and its `completeness`. A selection on a fork lists that fork's own reads (`reads[]` with source `Azure/osdu-spi-<fork>`) with their times, and GitLab reads for upstream work. "Not read" leads when core says something wasn't read (storage's Validation Summary job; partition's deployment cause). Item areas come from `provenance` and say they are the sweep's list until core narrows them per item. | Sol 6, Muse 5, Opus data |
| K | **Chips name kind and number.** "deployments ↗", "PR #83 ↗", "issue #72 ↗", "!968 ↗". No bare `link ↗`, no repeated number. One- and two-member lines show a real short cause. | Muse 6, Opus nits |
| L | **Port starts the port.** Primary "Port !968 (Copilot thread)", second "Open !968 on GitLab ↗". | Muse 7 |
| M | **Every actionable object has a disposition.** A new Today section, **Can wait**, has one line per place-held pile: 14 release PRs (1 ready to merge, 13 waiting for review, none failing), 15 human-required issues, 7 chore PRs and 27 Dependabot bumps, and the security counts. Each links to its place. The Line's Release column is gone; release PRs belong to Releases. | Sol 1, Opus data |
| N | **The vocabularies say unknown and failed.** Stations add ⌀ not read; a running lane whose last run failed reads "◐ rerunning · last run failed". Rollout stages are verified, merged · verification pending, to dispatch, failed, not read. Merged comes from Sync Template's own merge results (`since.rows[template].slots`), not from occupied slots. | Sol 5, Opus nit |
| O | **"Last 24 hours", with the failures.** `since.basis` is fallback and `seen.cursor` is null, so the section says Last 24 hours. Sync Upstream names its failures (indexer, search, crs-conversion) and its not-read results. It reads "Since you last looked" only when `seen.cursor` exists. | all three |
| P | **Nits.** Ages in one unit (6d 22h reads 7d). Cells wrap to two lines. Campaign chips are labelled Highlight. The home in a line's Detail is a link. Times are local. "Release/upstream PR" everywhere. Upstream cells link to the real GitLab project path from the sweep's reads; cell PR links come from the cell's inspect target. | all three |

**Declined.** Muse asked that the Line's "n yours" exclude the four absorbed `radar:` items. With ruling D each absorb member is one member on the Line (its Sync PR cell), so the Line's count is 16 members, not 20 items, and both readings agree.

## Round 3 result

Round 3 scored Opus 9 and Sol 9, each with no must-fix findings; Muse scored 9 in round 2 with none. Opus's last nits are applied: a no-member cell marks its fork's other stations that are on Today, upstream sources are named as upstream commits, the plan line names the fork outside any wave, and the evidence chip always gives reads and areas.

## Round 2 rulings

Round 2 scored Opus 8.5, Sol 8.5, Muse 9.

| # | Ruling | Answers |
|---|---|---|
| Q | **Lanes busy comes from the stations.** Re-run's condition and Moving without you count lanes whose station is running: "1 lane busy: partition". Core's `flow.tiles[Lanes]` says "2 busy · partition, storage" while storage's lane station is stopped; core fixes the tile. | Opus 1 |
| R | **A stopped cell with no item says so and still has a way out.** search's Lane opens its deployment history and says core raised no item and the lane's run was not read. A cell with no read run opens the fork's Actions page. | Opus 2, Sol nit, Muse nit |
| S | **A member's age is the age of the object you act on.** Absorb members use the sync PR's age (unit 10d); the cause adds "queued upstream 59d ago". | Opus 3, Sol nit, Muse nit |
| T | **Also on Today uses the line's short cause** ("red on its failed lane"). | Opus 4 |
| U | **Can wait excludes what is on Today.** "8 human-required issues not on Today (7 more are sources of items above)". Every Can wait pile applies the same exclusion; Template still shows the total. | Sol 1 |
| V | **Line Details without a lead say Cause and Next.** Approve and merge · 2 and Investigate · 2 show the shared cause or each member's next; the primary reads "… (oldest) ↗". | Muse nit |
| W | **Copy.** "Queue the re-run of all 5 lanes", before Dispatch takes any lane. Its condition sits under the verb. Cells wrap to three lines. The Sync column is "Sync" (it holds a PR or a run). Repository columns all say "· all". Sources name GitLab commits and runs. A breadcrumb-revealed cell stays selected. | all three |

Core work added by round 2: the `Lanes` tile disagrees with the stations; search's failed Sync Upstream (`services[search].runs[0]`) and its failed lane (`places[0].reason`) have no items; the member-age rule (`radar:unit.age` 59d against `gate1:unit.age` 10d) belongs in the verb-line field.

## The idea

Five layers, each answering one question, each one click from the next:

| Layer | Answers | Holds |
|---|---|---|
| **Today** | What is mine to move today? | Only items whose next move is the operator's, as a table of headlines grouped by situation; one row per pile that can wait; what moves without you; the last 24 hours. |
| **A place** (Line, Environment, Template) | Why, and what else is going on here? | The place's instrument: the fork × station sheet, the stack's timeline, the rollout and the repositories. The operator's items are marks on it, never a second list. |
| **Detail** | What is this one thing, and what do I do? | One anatomy for every selection: where it lives, cause, effect, next (only when there are two ordered moves), one primary action, the links that are not buttons. |
| **Evidence** | How does SPI Code know? | What was not read, the reads behind the selection with their times, and the areas core attributes. |
| **The source** | The thing itself | The PR, issue, run, job, commit or GitLab MR, opened in the browser. |

Today is a to-do list, not a summary. State lives in the sidebar and on the places; Today says nothing the sidebar already says.

## Today

1. **Blocked**: items that stop something until you act (core's rung 0).
2. **Waiting on you**: everything else whose next move is yours.
3. **Can wait**: one row per pile that is yours but not today (Release PRs, Repositories, Security), as counts. Nothing waits on them. The row opens its place.
4. **Moving without you**: at most three rows, each a thing in motion or scheduled, time first. The row opens its place.
5. **Last 24 hours** (or "Since you last looked", when core has a seen cursor): one row per workflow, as counts per outcome; failed in red, merged in green, names on hover.
6. On a calm morning Blocked and Waiting on you are replaced by "Nothing is yours to move today."

**Rows.** Fork, What, Open, Age. A single item is one row: fork, headline, its source pill, its age, and a clock when it has a deadline. A group is a header row ("5 forks", the shared headline, the oldest age) and one sub-row per member (fork, pill, age).

**Three grouping rules** (unchanged; verbs drive grouping but never show):

1. **Whose move decides Today.** An item is on Today when its next move is the operator's, whatever its tier.
2. **One member per object.** Items on the same PR are one member, and Detail names both moves in order (upgrade os-core-common on the fork, then review the sync PR).
3. **A blocked item's move is its blocker's.** The five red release/upstream PRs failed Deploy and Test › Verify on their lanes; their move is the re-run, so they group under "release/upstream PR red: its deploy lane failed", and that move shows wherever the PR shows.

On the 16 Nov snapshot this turns 23 items into 10 rows and 18 members: 2 Blocked, 16 Waiting on you.

**Click targets.** The fork or the headline opens the row in Detail (a one-member row opens the member). A sub-row's fork opens that member. A pill opens the source in the browser. Detail's breadcrumb opens the place with the subject marked.

## Places

**Every place has the same head**: its name; its status (one field, which the sidebar reads too); then "n yours on Today ‹ ›", which steps through the place's members, marking each on the instrument and opening it in Detail.

**Line.** Status "7 of 13 forks stopped". The wave plan in one line. Campaign chips highlight forks carrying a toolchain move. The sheet: fork × Upstream, Sync PR, Cascade, Main, Lane, each cell a glyph from one vocabulary (✕ stopped, ! waits on you, ◐ running, ◷ waits on time, ⌀ not read, · fine) and its text on up to two lines; a dot marks only a cell that holds a member whose home is the Line, so the dots, the head's count and its stepper agree. A cell holding a Today item homed elsewhere, such as an upstream member on the Upstream column, gets no dot and no second mark and keeps its own glyph. Forks with only fine and waiting cells fold into "▸ n moving normally" unless every fork is quiet. Release PRs are on Releases.

**Environment.** Status "v0.35.5 ready · green since Sun 22:12", with "smoke failed 2× on fresh clusters today; the running environment was not affected". Three tiles, the last 24 hours as lanes, 21-day pass rates, and one line pointing fork lanes to the Line's Lane column. Nothing here is on Today on 16 Nov, so the head has no stepper.

**Template.** Status "Rollout 1a4730d: 1 verified · 5 merged, verification pending · 7 to dispatch". The rollout ladder with a stage per rung and a dot on the 7 Dispatch reaches. The repositories table (issues, PRs, Dependabot), each row marked "on Today" when a line in it is; each line opens in Detail, and a line that is an item's source opens that item.

## Detail

**One anatomy for every selection** (member, group, Line cell, environment run, rollout rung, repository line):

1. **Breadcrumb** to where it lives: Line › fork › station, Template › repository › Issues, or Template › Rollout › fork; for a group, Today › its place. Each part opens the place with the subject marked.
2. **On Today** chip, only when you arrived from a place: "On Today · 5 red release/upstream PRs", which opens the row.
3. **Title**, then the deadline in full when there is one, and the cell's, rung's or line's own state when that is how you got here.
4. **Cause and Effect**, each one or two sentences, no core error codes. **Next, in order** only when there are two moves; the first step is the one the primary action takes.
5. **One primary action**, named for what it touches, and at most one second button. On GitHub the action is the link ("Review PR #41 on GitHub ↗"). In SPI Code the action starts it ("Add a filter rule for schemathesis-tests", "Queue the re-run of all 5 lanes").
6. **Also on GitHub**: links behind it that are not already buttons, including the sync engine's companion issue.
7. **The evidence chip**: "Read 18:37–19:06 · 8 reads · 9 areas · Evidence ›".

## Evidence

Not read first, when core says so. Then the reads of the selection's fork (object and time), and the GitLab project reads for upstream work. Then the areas: for items, core's `provenance` paths; for cells and rungs, inferred from the view and labelled so. Each area says the whole sweep's one phrase; its state, observed time (and how long before the sweep ended) and completeness are the row's hover and accessible name (spicode-djg.35). With nothing selected it lists every source, and each row says only the facts that carry information: "read · 4 s", "not due · from 09:29", "read · 22 s · 5 reads failed" with one muted cause line, "failed · showing 09:26". Ruling J's four facts are the row's hover and accessible name; a failure is said once, in one tone, and Failed reads keeps only failures no row shows (maintainer, 2026-11-17, spicode-djg.33). After a failed or partial read the page's button reads Read again, a normal sweep that re-reads every due source, failed ones included (spicode-djg.34). No logs; a job log is read by Copilot in a thread.

## Out to GitHub and GitLab

- **One mark, one meaning.** `↗` opens the source in the browser and does nothing else.
- **Every object reference is a chip** with its kind and number. GitLab chips use the upstream colour.
- **Keyboard**: Enter opens in Detail; ⌘↵ opens the selection's primary source.
- **GitLab opens.** The desktop allow-list adds `community.opengroup.org`.

## One fact, one field

| Fact | One field | Read by |
|---|---|---|
| Forks stopped | Line status: a stopped Upstream, Sync, Cascade or Main station | Sidebar Line, capsule Forks, Line head |
| What is yours | Verb-line members (core) | Sidebar Today, Now and Today counts, each place's "n yours on Today" |
| Environment state | Environment status | Sidebar, capsule, Environment head |
| Rollout | Engineering status: verified, pending, to dispatch, failed, not read | Sidebar, Engineering head, rungs, Dispatch member |

## Data and core work this needs

- **`next.actor`, `subject`, `blockedBy`** on items. The mock infers them from the verb, the id prefix (`build.py:home()`) and the "is red" title; these become core fields.
- **Verb lines as a core field** (spicode-7yu.1), with the three rules, the condition ("after lanes drain") and ordered steps for two-move members.
- **Repository lines resolved to items** by URL and by the sync engine's companion-issue rule (the mock does it in `build.py`).
- **The halt-issue check.** Core's `sync-run:indexer` said no halt issue was open while `repositories.rows[indexer]` held #72, read in the same sweep. Core joins the halt issue to the sync-run item.
- **Place status** as one core field per place.
- **Per-item provenance.** `provenance` maps every `/briefing/focus|rest/n` to all 9 areas; core narrows it per item, and host inspect fills `provenance` (it sets `[]` at `packages/host/src/inspect/item.ts:90`).
- **Cell links** resolve through each cell's `inspect` target; the mock builds Main and Sync PR links from the cell's `#n`.
- **Which release PR is ready to merge.** `releases.today.readyLine` counts it but no field names it.
- **Rollout verification.** The mock reads "merged" from Sync Template's merge results and "verified" from `slots[].state == done`; core names the verification read behind done.
- **The desktop allow-list** adds GitLab (`apps/desktop/src/external-links.ts:20`).

## Out of this round

Upstream, Security and Releases keep their pages; Today and Detail link to them. The shell is settled.
