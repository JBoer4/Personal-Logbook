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

- Specifics TBD — noted during usage, details to be captured as they come up

## Logging structural changes

- Details TBD — to be captured when work begins
