// Sync engine: push dirty records, pull changes

import { useEffect } from 'preact/hooks';
import { db } from './db.js';
import { api } from './api.js';

let syncing = false;
let syncListeners = [];
let appliedListeners = [];

export function onSyncStatus(fn) {
  syncListeners.push(fn);
  return () => { syncListeners = syncListeners.filter(f => f !== fn); };
}

// Fires only when a pull applied records this device hadn't seen —
// views use it (via useSyncRefresh) to reload in place.
export function onSyncApplied(fn) {
  appliedListeners.push(fn);
  return () => { appliedListeners = appliedListeners.filter(f => f !== fn); };
}

// Re-run a view's load() whenever sync pulls down changes. Subscribes
// fresh each render so the callback never closes over stale props.
export function useSyncRefresh(fn) {
  useEffect(() => onSyncApplied(fn));
}

function notify(status) {
  syncListeners.forEach(fn => fn(status));
}

export async function sync() {
  if (syncing) return;
  syncing = true;
  notify('syncing');

  try {
    const lastSyncAt = (await db.getMeta('lastSyncAt')) || 0;

    // Gather dirty records
    const [
      dirtyBudgets, dirtyCategories, dirtyEntries, dirtyEvents,
      dirtyOverrides, dirtyTransactions, dirtyPeople, dirtyPersonNotes,
      dirtyMoneyPlans, dirtyMoneyRules, dirtyDayNotes,
    ] = await Promise.all([
      db.getDirtyBudgets(), db.getDirtyCategories(), db.getDirtyEntries(),
      db.getDirtyEvents(), db.getDirtyOverrides(), db.getDirtyTransactions(),
      db.getDirtyPeople(), db.getDirtyPersonNotes(),
      db.getDirtyMoneyPlans(), db.getDirtyMoneyRules(), db.getDirtyDayNotes(),
    ]);

    const payload = {
      lastSyncAt,
      budgets: dirtyBudgets.map(db.cleanRecord),
      categories: dirtyCategories.map(db.cleanRecord),
      entries: dirtyEntries.map(db.cleanRecord),
      events: dirtyEvents.map(db.cleanRecord),
      periodOverrides: dirtyOverrides.map(db.cleanRecord),
      transactions: dirtyTransactions.map(db.cleanRecord),
      people: dirtyPeople.map(db.cleanRecord),
      personNotes: dirtyPersonNotes.map(db.cleanRecord),
      moneyPlans: dirtyMoneyPlans.map(db.cleanRecord),
      moneyRules: dirtyMoneyRules.map(db.cleanRecord),
      dayNotes: dirtyDayNotes.map(db.cleanRecord),
    };

    const result = await api.sync(payload);

    // Merge all server records into local (clean, not dirty).
    // This covers both server-side changes AND our pushed records
    // (the server returns everything changed since lastSyncAt).
    // putClean reports whether each record was actually new here;
    // our own pushed records come back unchanged and don't count.
    let changed = 0;
    for (const r of result.budgets || []) changed += await db.putBudgetClean(r) ? 1 : 0;
    for (const r of result.categories || []) changed += await db.putCategoryClean(r) ? 1 : 0;
    for (const r of result.entries || []) changed += await db.putEntryClean(r) ? 1 : 0;
    for (const r of result.events || []) changed += await db.putEventClean(r) ? 1 : 0;
    for (const r of result.periodOverrides || []) changed += await db.putOverrideClean(r) ? 1 : 0;
    for (const r of result.transactions || []) changed += await db.putTransactionClean(r) ? 1 : 0;
    for (const r of result.people || []) changed += await db.putPersonClean(r) ? 1 : 0;
    for (const r of result.personNotes || []) changed += await db.putPersonNoteClean(r) ? 1 : 0;
    for (const r of result.moneyPlans || []) changed += await db.putMoneyPlanClean(r) ? 1 : 0;
    for (const r of result.moneyRules || []) changed += await db.putMoneyRuleClean(r) ? 1 : 0;
    for (const r of result.dayNotes || []) changed += await db.putDayNoteClean(r) ? 1 : 0;

    await db.setMeta('lastSyncAt', result.syncedAt);
    notify('synced');
    if (changed > 0) appliedListeners.forEach(fn => fn());
  } catch (e) {
    console.warn('Sync failed:', e.message);
    notify('offline');
  } finally {
    syncing = false;
  }
}

// Fire-and-forget sync attempt after a mutation
export function syncAfterMutation() {
  sync().catch(() => {});
}

// Debounced variant for rapid-fire edits (typing in inputs, etc.)
let debounceTimer = null;

export function debouncedSync(delay = 500) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => syncAfterMutation(), delay);
}

export function startSyncLoop() {
  // Initial sync
  sync().catch(() => {});

  // Poll while visible. This is what keeps a device with no local edits
  // up to date — an empty pull is one tiny changes-since request.
  setInterval(() => {
    if (document.visibilityState === 'visible') sync().catch(() => {});
  }, 30000);

  // PWA resumed from background / tab refocused: catch up immediately
  // rather than waiting for the next poll tick.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sync().catch(() => {});
  });

  // Sync when coming back online
  window.addEventListener('online', () => sync().catch(() => {}));
}
