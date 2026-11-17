# The service home and Today

The clickable [draft 9 mock](spi-code-service-home.html) shows the home of one fork and Today across all 13. Where the mock and this file differ, this file wins.

The council (Opus 5.5, Codex Sol, Muse Wonder) held seven rounds on the service page. In round 7 they scored draft 7 at 8.5, 8.5 and 8.5, with no structural finding since round 4. On 2026-11-17 the maintainer approved draft 8 without a council score, with three changes after the last round. Healthy Main gained a green tint, the Code tab was cut, and the round-7 fixes were applied. The maintainer aligned on draft 9's Today the same day. The council did not score draft 9.

## The service home

| # | Change | What it shows |
|---|---|---|
| 1 | Top bar | Service name, repo pill, current version to next version with the bump in words (patch, minor, major), typed release PR pill, template icon and pin. The template icon opens Template and shows a check or grey “behind”. Unknown draws nothing. |
| 2 | Flow | Upstream, Sync PR and Integration lead into Main, with connectors always drawn. Each station shows its mark, short state and PR. Its second line names what it holds or when it moves. The opened row gives the cause. Healthy Main is tinted green. “Straight into main” has doors with counts for Release, Other PRs, Dependabot and Template when it holds a sync PR. Each open PR belongs to one station or door. A station or door that holds an Overview row opens it. |
| 3 | Tabs | Overview, Upstream, Pull requests, Issues, Runs and Security. Grey counts show changes to port, open PRs, actionable open issues, workflows failing now and alerts in shipped code. An unread count is ⌀. |
| 4 | Overview | Blocked, Waiting on you, Shared work and Can wait use Today's words. The typed pill links out and the headline opens the cause in place. Shared work is neutral, carries no count and says “Counted on Upstream”. Can wait is oldest first. A quiet fork says “Nothing waiting on you” or shows the not-read line with its Evidence link. |
| 5 | Upstream | To port is neutral. Next sync shows what is queued. Open upstream gives the total, the MRs shown and one line accounting for the rest. |
| 6 | Pull requests and Issues | One row per PR or issue. Its typed pill links out and its title opens a summary in place. Line one is checks. Line two is the gate in Overview's words. Amber marks Waiting rows. A failed check is always red. PR filters are Open, Merged (merged only) and All. Issue filters are Open, Closed and All. A proven tracking issue rides on its PR, stays out of the issue count and appears under All as “tracks PR #n”. |
| 7 | Runs | “Failing now” lists a workflow from its last failure until its next pass. A cancelled or running retry leaves it listed. Below it, one strip per workflow has one square per run. Each square opens its run. |
| 8 | Security | One list groups Shipped SPI code, Shipped upstream code and In tests. Font weight conveys severity. Each row has a typed Dependabot or CodeQL pill. A grouped count opens in place to individual pills with severity. A fix PR closed unmerged sits by its alert as a grey “closed” pill. |
| 9 | Service mark | The pinned sidebar row and search result share one mark. It counts Blocked plus Waiting rows, filled red if any is Blocked and ringed amber otherwise. With no rows it shows a check, or ⌀ if an area was not read. A known count stays visible. |
| 10 | Search | Under a service, list its open PRs and issues by number or title, then its tabs with their counts. Choosing a PR or issue opens its row on its tab. |
| 11 | One clock | Every run, merge and age uses the operator's local clock. Show time alone today, weekday and time within a week, and a date beyond. Durations such as 7d stay durations. Use counts without “n of m”. Amber and red state marks mean Waiting and Blocked. |

Out of scope are the Code tab (clone, editor, terminal), a subtree under a pinned service, Release and Lane stations, a headline above the flow, release history, run strips on Overview, in-app diffs, timelines, comments and Copilot actions (Z7). Worktrees and PR checkout arrive with chat.

## Today

| Part | Ruling |
|---|---|
| Fleet flow | Upstream counts forks stopped there, Sync PR counts forks with a sync PR open, Integration counts forks with an integration PR open, and Main counts green forks. Each figure is the number of forks in that station state, including forks with nothing in Yours. Environment shows its state and version and opens its place. Main has no button. The doors are Template, Release, Dependabot and Other PRs. A station or door figure with a missing read keeps its known count and carries ⌀. |
| Filter | Upstream, Sync PR, Integration and the Template door toggle their filter. It keeps matching rows and group members in Yours, hides Can wait and dims other columns in Forks. “Show all” clears it. Pressing a filter from Activity opens Yours. A filter with ⌀ shows its known rows and the not-read line. Release and Dependabot open their Can wait rows. Other PRs opens the cause with the most forks. A door with nothing behind it has no button. |
| Yours | Blocked and Waiting on you keep the table and group by situation. Headlines expand the rows and fork names open their service pages. The count is the same member count the sidebar, dock badge and tray use. A deadline stays on its row as a clock. |
| Can wait | List causes with their forks inside, leaving out what is already in Blocked or Waiting on you. Release is one row with each fork's PR age. Dependabot is one row with each fork's count and the ecosystem/package pairs shared across forks, regardless of version. Other PRs and actionable issues group by normalized title within each category (trim, collapse whitespace, fold case). High or critical alerts in shipped SPI and upstream code form one row with each fork's count and the rules with the most alerts and most forks. Release and Security open their places. Fork pills open the service or its tab with the row open. |
| Forks | The tab counts stopped forks. The sheet lists each fork's four stations, Template PR number, Release PR age, Other PR count and failure mark, Dependabot count and service mark. Forks with Blocked or Waiting rows come first in fleet order. One fold says how many of the rest there are and what they hold. Forks with unread stations stay visible. A fork's name expands its Yours rows and Can wait facts in place. `Open <fork> ›` opens its service page. ⌘L opens Forks. |
| Activity | Moving without you and Last 24 hours move here with their existing readings. |

## Rulings

| # | Ruling |
|---|---|
| D1 | A service is a place with tabs. |
| D2 | A service lists the operator's work on Overview. This changes Today and places ruling I for the service page. |
| D3 | Stations and doors lead to rows in place on the service page and Today. This changes Z3 on those surfaces. |
| D4 | Count the fork-wide port row once, on Upstream. List it as Shared work on each service that owes ports. Upstream's sidebar mark is a warning-ring count of its Today rows when it has any, and the next-sync clock otherwise. |
| D5 | Today's Forks tab takes the Line's place (PS-10 and ruling F). The Line sidebar and Find rows, dockable sheet, cell dots and popovers go. So do the place head stepper and the rule that its counts add up to Today, the On Today chip and the opened row's place link. Core keeps member homes. |
| D6 | Today has an instrument. The fleet flow and sidebar can show the same fact from the same field. |
| S1 | Integration combines the cascade state with the integration PR (`cascadePr`). A failed lane shows as a red integration PR. Main shows main's own health and its last merge. Lanes belong to Environment. |
| Q1 | Keep the Release door and the release PR pill in the top bar. |
| Q2 | Draft 9 supersedes Q2. Use Integration on the service page, Today and the Forks column. Cascade goes with the Line. The workflow keeps its GitHub name, Cascade Integration. When the branch is behind, Today says “Integration PR needs its branch updated, then approval”. |
| Q3 | Core raises a Blocked “Sync failed” row when the latest finished Sync Upstream run failed while a sync PR is open. A cancelled or running retry leaves it blocked. The next pass clears it. |
| Open upstream | Show open non-draft MRs that moved within 30 days, newest first. Count the rest once as drafts or idle over 30 days. |
| Template | A template sync PR sits at the Template door on both the service page and Today. The sidebar counts template sync PRs waiting for review, the same figure as Today's Template door. |
| Not read | Show ⌀ for an unread value. Reserve 0 and “None open” for a known empty read. |

Q1–Q3, Open upstream and Template were settled on 2026-11-17 on `spicode-mw0`. S1 and the build rulings come from its breakdown.

## Build rulings

| Area | Ruling |
|---|---|
| Prototype | Close the prototype bead at handoff. Builders branch from main and port from its diff. After the service shell, each list bead owns its projection and its tab. The sweep folds in rulings from the prototype checkpoint. |
| Open PRs | Prove the station and door partition by PR identity, including partial reads. A failed or capped per-fork PR read leaves door counts unread. A known forge total still serves the Pull requests tab. |
| Main | Take the last PR merged into main from `PAST_PULLS`, regardless of kind. |
| Runs | Use one bounded recent-runs read across workflows and one failure reducer shared by Runs and Q3. |
| Issues | Read closed issues apart from the halt feed. The open halt issue is the halt item's primary link (indexer #72 in the 16 Nov facts). Keep the run as evidence and use it as the primary link when no halt issue is open. |
| Checks | Port T3 Code's check classification with its notice and use this page's words for the roll-up. |
| Security | Match a closed Dependabot fix PR to its alert by package and manifest directory. |
| Reachability | `spicode-mw0.6` inventories the old service page's PS-02 fields and gives each a home within one click or a named exemption for the sweep. |

## Mock data

The To port rows, the mock's Open upstream selection rule, partition's unread Issues state, storage's template-behind state and the Forks rows marked “example” are examples. Live reads use the Open upstream ruling above.
