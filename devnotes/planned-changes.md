# Planned Changes — Design Decisions

Captured from design discussion 2026-02-23. Implement one item at a time in separate sessions.
Reference this doc at the start of each implementation session.

---

## 1. Event-Based Time Logging (REDESIGN — do first, everything builds on it)

### Summary
Replace the current category-first entry model with an event-first model. You add an event; category is a field on it.

### Data model changes
- `entries` → rename conceptually to `events`
- Fields: `id`, `budgetId`, `date` (start date, YYYY-MM-DD), `startAt` (local ISO datetime, nullable), `endAt` (local ISO datetime, nullable), `hours` (manual duration, nullable), `description` (text, nullable), `categories` (array of categoryIds), `createdAt`, `updatedAt`, `deleted`
- `startAt`/`endAt` replace the old `startTime`/`endTime` strings — now full datetimes to handle midnight crossover unambiguously
- `hours` is for manual entries with no start/end
- Multi-category: array of category IDs (may be 1 or more)

### UI changes (DailyLog.js)
- Remove category-grouped layout
- Add single "+ New Event" button at top
- Below it: list of events for the day, sorted by:
  - Open events first (have `startAt`, no `endAt`) — highlighted/distinct
  - Then by `startAt` ascending
  - Manual entries (no `startAt`, no `endAt`) at bottom
- No default start time on new event form
- All fields shown on the add form: category (required, multi-select), description (optional), start time (optional), end time (optional), duration (optional)
- Duration input: accepts natural formats — `30m`, `1h`, `1h30m`, `90m`, `1.5` — parsed client-side (no network needed)
- If start + end both filled, duration auto-calculates
- If calculated duration > 12h, show inline warning ("16h — looks right?")

### Multi-category behavior
- An event can belong to multiple categories
- Full duration counts toward each category (double-counting is intentional — reflects concurrent activities)
- Weekly/period totals per category may exceed 168h; UI should not frame this as "hours in your day"

### Midnight crossover
- Events are stored once, anchored to start date
- For reports/totals queried by date: split cross-midnight events at midnight, attribute each portion to its respective date
  - Example: sleep 10pm Day 2 → 7am Day 3 = 2h on Day 2, 7h on Day 3
- Visualizer reflects the same split

### Timezone
- Local device clock is truth — no timezone conversion or storage
- User handles timezone shifts manually if needed; no app-level solution

---

## 2. Hierarchical Categories (REDESIGN — do second, needed for reports)

### Summary
Replace flat category list with an n-level tree.

### Data model changes
- Add `parentId` (nullable) to `categories`
- `parentId: null` = top-level group (e.g. "Work", "Hobbies", "Social")
- Children reference parent by ID
- N levels of nesting allowed; no arbitrary depth limit enforced by the app

### Behavior
- Hours roll up from children to parents for reports and progress bars
- Category picker on events shows the tree (indented or grouped)
- Can tag an event with a leaf category or a parent category

### Still to discuss
- How category picker UI should work on the event add form (search? tree drill-down?)
- Whether targeting (goal hours) lives on leaves, parents, or both

---

## 3. Goal Ranges

### Summary
Replace single target number with optional min/max bounds per category.

### Data model changes
- Replace `targetHours` on categories with `minHours` (nullable) and `maxHours` (nullable)
- Both optional — any combination is valid

### Behavior by configuration
- **Neither set** — pure tracking, no goal. Logs fine, not shown in weekly progress view.
- **Min only** — "do at least X" (e.g. job searching). Red until hit, green after.
- **Max only** — "don't exceed Y" (e.g. gaming). Green until hit, red after.
- **Both** — range. Red if under min, green if between min and max, red if over max.

### Weekly progress view
- Only show categories that have at least a min or max set
- Categories with no goal: omit from this view, or optionally collapsed under a neutral "Other" group at the bottom

---

## 4. Weekly Visualizer (new view)

### Summary
Replace or augment the current weekly summary with a two-section view. Daily log view is unchanged — no charts there.

### Top section — 7-day overview
Seven columns (S M T W T F S), each column contains two elements side by side:

**Timeline strip (left, narrow)**
- Vertical, full 24 hours always (top = midnight, bottom = midnight)
- Events rendered as colored blocks at their actual time positions
- Empty space where nothing is logged
- Manual entries (no start/end time) skipped — not plottable
- Overlapping events: split the column width for the overlapping time slice (two thin strips side by side)
- Purpose: spot time-of-day habits and patterns across the week ("I game every night at 7pm")

**Stacked bar (right)**
- Vertical stacked bar, one segment per category, colored by category
- Height represents hours — 24h minimum so days are visually comparable; can exceed 24h if double-counted concurrent events push the total over
- Purpose: see at a glance the ratio of what you spent time on each day

### Bottom section — category summary
- Horizontal progress bar per category (same concept as current weekly view)
- Only shows categories that have a min or max goal set
- Goal range marker on each bar (target zone visualized)
- Color indicates goal status: green = in range, red = under min or over max
- Categories with no goal: omitted, or collapsed in a neutral "Other" group at the bottom

---

## Implementation Order (recommended)

1. **Hierarchical categories** — data model foundation; event system and visualizer both depend on it
2. **Event-based logging** — replaces entry model; depends on category tree being in place
3. **Goal ranges** — `minHours`/`maxHours` on categories; categories need to be stable first
4. **Copy from previous week** — period setup flow; depends on goal ranges being defined
5. **Weekly visualizer** — timeline strip + stacked bar + category progress; depends on events having datetime data and goal ranges being defined

---

## 5. Period Templates — Copy From Previous Week

### Summary
No automatic copying. When a user wants to set up a new period they can explicitly copy category targets from any previous week that has data.

### Desired behavior
- "Copy from a previous week" action available when setting up a period
- Shows a picker listing all weeks that have logged data
- User selects any week; its category configuration (including `minHours`/`maxHours`) is copied to the current period
- No default/automatic copy — always an explicit user action

### Category changes and orphaned events
- When a category is deleted or restructured, events referencing it become "uncategorized"
- UI should surface orphaned events for reassignment: either a prompt on delete ("reassign X events to...") or a visible "uncategorized" bucket to clean up at leisure
- Build this in from the start during the event system redesign — do not bolt on later
- **Current data:** user accepts data loss from this week's category redesign; no migration needed for existing records

---

## Items Still To Discuss (from user's list)

- [ ] Visualizer / chronological organization — not yet discussed
- [ ] Any other pain points the user wanted to raise
