# Backlog

Captured after first week of real usage. These are the changes that drove extracting this into its own project.

## Data model changes

### Hierarchical categories
Currently categories are a flat list. Want groups with optional subgroups.
- Top-level groups (e.g. "Fitness") with subcategories (e.g. "Lifting", "Cardio")
- Group-level rollup: show total vs target at the group level
- This touches the data model, sync, and every component that renders categories
- **Do this first** — most other changes build on top of it

### Min vs max flag on categories
Currently all targets are implicitly maximums (don't go over budget). Need a flag per category to indicate direction:
- `max` — don't exceed this (default for spending)
- `min` — hit at least this (e.g. workout hours, sleep)
- Affects how progress bars are colored and how "on track" is calculated
- A min category that's exceeded should show as good (green), not over-budget (red)

## Templates

### Copy from an arbitrary past week
Instead of rebuilding your category targets from scratch after an unusual week, pick any past period and copy its targets as the starting point for a new one.
- Needed for: recovery weeks after travel, workout cycles where week 3 has different targets than week 1
- UI: when starting a new period, option to "copy from..." with a period picker

### Template management
Save named templates (e.g. "Loading Week", "Deload Week", "Travel Week") that can be applied to any period.
- More powerful than copy-from-past but more work to build
- Probably comes after copy-from-past is working

## Visualizations

### Daily category bar charts (DailyLog)
At the bottom of the daily log, after the event list, show horizontal (or vertical) bars per category/group for the current day.
- Show subcategories AND their parent groups (parent bar = rollup of children + any direct hours)
- Exclude categories with 0h logged that day
- Purely informational — no goal reference, no cap at 24h
- Accepts double-counting: bars can sum to >24h (reflects "hours of attention")
- Requires parent rollup logic (see below)

### Weekly timeline — union-of-intervals for day height
Currently day column height = sum of all event hours, which inflates when events overlap.
Should use union-of-intervals across all timed events so the bar never visually exceeds 24h.
Manual-hours events (no startAt/endAt) add their hours directly as a flat block.

## Logging structural changes

### Fractional hour input
`parseDuration` in utils.js currently requires a leading digit — `.5` fails, `0.5` works.
Fix: update the bare-number regex to accept leading-dot decimals (`.5` → 0.5h, `.25` → 0.25h).

### Parent category hour rollup
Everywhere category totals are computed (BudgetHome, daily bar charts), hours attributed to a subcategory must also accumulate into all ancestor categories.
Currently `parentId` is not consulted in BudgetHome's `hoursByDayCat` loop — parent groups show 0h even when subcategories have entries.
