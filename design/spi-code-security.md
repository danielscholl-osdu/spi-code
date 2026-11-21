# The Security place

The clickable [draft 10 mock](spi-code-security.html) shows where the open alerts pile up across the fleet, by rule and by repository. Its counts are the 20 Nov 2026 sweep's; its paths, alert and PR numbers, advisories and versions are made up (spicode-dxj.12), so nothing new about open vulnerabilities is published. Where the mock and this file differ, this file wins.

The council (Opus 5.5, GPT-6.2 Sol, Muse Wonder 1.0, Gemini 4 Neon) held three rounds on drafts 7 to 9 and scored draft 9 at 9.0, 8.5, 8.6 and 8.5, with no structural finding. On 2026-11-20 the maintainer approved draft 10: draft 9 with the maintainer's own changes, not council-scored. A block's label is its count alone, at the block's end. The grouped block has a divider at each rule. A tick's solid part is its share of high. Every SPI rule with a high alert keeps its own block.

For the Security place this file wins over its mock, [today and places](spi-code-today-and-places.md), the window layout, the window design and the visual design. Ask about this follows [threads](spi-code-threads.md).

## The page

| # | Part | What it shows |
|---|---|---|
| 1 | Totals | One line of open alerts by scanner, in GitHub's terms: "275 open alerts: 82 Dependabot, 193 code scanning." |
| 2 | Headline | High alerts in shipped code, how many are ours, and how concentrated they are: "121 high alerts in shipped code. 24 are ours to fix, 22 from one rule in 12 forks." |
| 3 | Not read | One banner names each list not read, with its Evidence link. |
| 4 | Figure | Three bars on one scale: Shipped SPI code ("Ours to fix"), Shipped upstream code ("Upstream’s to fix, the fix arrives by sync") and Tests, tooling and settings ("Not in the running service"). Each has its total and how many are high or critical. A block is a rule or package sized by its alerts. Its solid part is its share of high or critical, from the left; the rest is outlined. A list not read is a hatched stub at the end of every bar. Colour says whose move it is, never severity. A legend gives the two swatches, and Not read when a list was not read. |
| 5 | By rule | The chosen bar, one row per rule or package: worst severity, the scanner's own title, its second line, a strip with one tick per repository, the line under the strip, a count bar, and fix and age. |
| 6 | Opened rule | What the rule or package is, where it sits by repository and file, a pill per alert and per fix PR, the same rule in the other bars, and Ask about this after them, at the left. A code rule's "What it is" line is the scanner's full description on one line, cut at the last space within 300 characters and left out when those hold no space, and its CWE closes the Rule line; either is left out when the scanner gives none. |
| 7 | By repository | The chosen bar, one row per repository with alerts: its name, its bar and count, its total across the page and its top rules. The repositories with nothing share one line. An opened repository lists its rules as pills that open the rule in By rule. |

Choosing a bar's name chooses that bar. Choosing a block chooses its bar and opens its row. Rows open in place: Security has no popovers, although today and places gives places popovers.

A block gets its own block when it holds at least 4% of the longest bar's alerts. In Shipped SPI code every rule with a high or critical alert keeps its own block however small. The rest of a bar share one block, labelled with their count, with a divider at each rule and their names in its tooltip. Blocks go by alert count. A tick's height grows with the square root of its count, on one scale for the bar.

## Order

| Where | Order |
|---|---|
| Blocks in a bar | Alert count. |
| By rule | Worst severity, then how many are high or critical, then alert count. |
| By repository | Alerts in the bar, then high or critical, then name. The bar encodes the same number, so bars shrink down the list. |
| Where, in an opened rule | Repositories by count, then name; pills by file, then number. |

## Not read

A list is one scanner's alerts in one repository. The sweep reads both lists of a repository at once and writes one read record for it.

| The list this sweep | Its alerts | Read |
|---|---|---|
| Absent: hidden, 403 or 404, or never read | None counted | No |
| Retained from an earlier sweep because this read failed | Counted | No |
| Read and empty | Zero | Yes |

The banner names a repository and its list when one list was not read, and the repository alone when its whole read failed. When no list was read at all (before the first security read, or every read failed) the page shows its title, "Security not read." and the banner naming each list not read, with no counts and no bars.

≥ sits only on a number an unread list could change. A count is a number with that mark beside it, never a string with ≥ in it.

| Number | Carries ≥ when |
|---|---|
| A bar's total and its high count, and the headline's counts | Any list was not read |
| The totals line's total | Any list was not read |
| The totals line's Dependabot or code scanning count | A list of that scanner was not read |
| A rule's total, its fork count, its file count and its age | A list it draws on (Dependabot for a package, code scanning for a rule) was not read somewhere |
| The grouped block's count | Any list was not read |
| A repository's count from a list that was read | Never |
| A repository's counts in By repository | That repository's list was not read; its top rules then say they are from the lists read |

The line under the strip names the repository that holds most of a rule only when every list the rule draws on was read. The line of repositories with nothing counts only repositories whose lists were all read.

## Rulings

| # | Ruling |
|---|---|
| R1 | Fix column on a package with several advisories: "N advisories, first patched ‹lowest› to ‹highest›". One advisory states its one version. "no patched version" when no advisory has one. "N fix PRs closed unmerged" counts Dependabot PRs for the package and manifest closed unmerged. |
| R2 | A rule in one repository while a list it draws on was not read reads "≥1 fork", with the repository named on focus or hover. |
| R3 | Under a file heading a pill reads "CodeQL #80". The in-place expansion of a file's alerts stays. The pill carries no line number, and the sweep does not collect one. |
| R4 | The page opens on the first shipped bar that has alerts. A clean bar keeps "Nothing open" in its bar only. |
| R5 | The headline reads as the mock's. |
| R6 | Shipped upstream code's subtitle reads as the mock's. |
| R7 | The grouped block keeps ≥ in a partial sweep. |
| R8 | A program repository opens on GitHub; a fork opens its service page. |
| R9 | Each rule or package has a subject of its own, `security-rule:` and its key, so a thread asked from it owns that rule alone and its chip packs that rule's facts and Where lines. Ask about this is scoped to the rule's fork when it sits in one fork and every list it draws on was read. A rule in several forks or only in a program repository is asked in Program once Ask about this offers Program on a row with no fork (spicode-xia.39); until then it shows no Ask. |
| R10 | The mock's Campaign button and any other action on an opened row are not built; actions are M4. |
| R11 | Figures agree with other pages by matching measure: the service Security tab's count is alerts in shipped code, without tests; Template tallies high and critical in shipped code. |
| R12 | No snapshot: the place's title row and nothing under it. |

Core computes every number and every word the page shows. The window counts, sorts and pluralises nothing.

## Not built

The mock's switches above the window (Sweep, Fleet, Palette, Colour, Theme), its 40-repository layout test, Ink only and its notes below the window are proposal chrome.
