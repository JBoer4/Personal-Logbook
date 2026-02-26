# Benchmark — Working Notes

Personal tracking app: set category goals, log actuals, review on a cycle. Supports time (weekly) and money (OFX import). Local-first PWA synced over home network.

## Architecture

- **Frontend:** Preact + htm (vendored, no build step). SPA with manual router (`router.js`).
- **Backend:** Node/Express + SQLite (better-sqlite3), served over HTTPS. Runs in Docker.
- **Offline:** Service worker (`sw.js`) caches the app shell. Works fully offline; syncs when back on network.
- **Local storage:** IndexedDB via `db.js`. Soft deletes, dirty tracking.
- **Sync:** `sync.js` — timestamp-based, server is source of truth. Static LAN IP (10.0.0.244), port 3000.

## File Structure

```
server.js           — Express server, SQLite, sync endpoints
public/
  index.html        — App shell
  sw.js             — Service worker
  manifest.json     — PWA manifest
  style.css
  js/
    app.js          — Root component, routing
    router.js       — Client-side router
    db.js           — IndexedDB layer (all reads/writes go here)
    sync.js         — Sync logic
    api.js          — Fetch wrappers
    utils.js
    components/
      BudgetHome.js       — Time budget home (weekly view)
      DailyLog.js         — Daily time entry
      Categories.js       — Time category management
      Dashboard.js        — Overview
      History.js          — Past periods
      MoneyHome.js        — Money budget home
      MoneyCategories.js  — Money category management
      Transactions.js     — Transaction list
      ImportOFX.js        — OFX file import
    vendor/             — Preact, htm (CDN copies, no build step)
```

## Sync — Critical Invariants

Every mutation must sync across all devices on the network (PC browser, phone browser, installed PWA).

1. **Never hard-delete.** Use soft deletes (`deleted: 1` + updated `updatedAt`). Hard deletes are invisible to sync — the other device still has the record and will push it back.
2. **Always call `syncAfterMutation()`** after any local write.
3. **Sync returns deleted records.** The endpoint returns all records changed since `lastSyncAt`, including soft-deleted ones. The client filters them from UI queries but keeps them in IndexedDB.
4. **Service worker caches JS.** After a deploy, new SW installs on next load (`skipWaiting`), but user may need one reload to pick up new code. Fine — data sync is independent of code updates.

## Data Model (current)

**Time budget:**
- `categories`: `{id, name, color, targetHours, order}`
- `entries`: `{date, categoryId, hours, startTime?, endTime?, note?}`
- `periodOverrides`: `{periodStart, categoryId, targetHours}`

**Money budget:**
- `moneyCategories`: `{id, name, targetAmount, order}`
- `transactions`: `{id, date, amount, description, categoryId, source}`

Period is currently hardcoded to weekly for time, monthly for money.

## Sensitive / Local Files (gitignored)

- `cert.pem`, `key.pem` — generate with mkcert for your local IP
- `server-data/` — SQLite database lives here

## Event Model — Design Decisions

**Hours are "attention hours", not clock hours.**
- Every category an event is tagged with receives the event's full hours. A 1h event tagged [Lifting, Podcast] gives 1h to Lifting and 1h to Podcast.
- Overlapping separate events work the same way: each category gets full hours.
- Category totals can exceed 24h/day — this is correct and intentional.

**Multi-category events are NOT split.** Splitting would be wrong: "Lifting + Cardio" for 1h should show 1h in each, not 0.5h.

**Overlapping separate events** are the right pattern for parallel-tracked activities (e.g. Work 9–5 + on-call/Resting 12–2). Each category gets full credit.

**Parent category rollup:** Hours on a subcategory must also be attributed to all ancestor categories. "Lifting" (child of "Fitness") → Fitness gets those hours too. This is NOT currently implemented in BudgetHome and needs to be added everywhere category totals are computed.

**Weekly timeline bars** must use union-of-intervals (actual clock time covered), not sum of hours, so day columns never visually exceed 24h. Manual-hours-only events add directly to the union as a block.

**Daily bar charts** (DailyLog, bottom of page): per-category/group bars showing attention hours for the day. Informational only — no goal reference, no cap at 24h. Show only categories with >0h logged. Both subcategories and their parent groups are shown; parent bar reflects the rollup total.

## Planned Work

See `devnotes/backlog.md` for the current feature backlog.
