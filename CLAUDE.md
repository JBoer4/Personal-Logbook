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

## Planned Work

See `devnotes/backlog.md` for the current feature backlog.
